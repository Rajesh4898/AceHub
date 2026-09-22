(function () {
  "use strict";

  /* ---------------- Read session config from meta tag ---------------- */
  var meta = document.querySelector("meta[name='session-config']");
  var CFG = {
    code: meta.getAttribute("data-code"),
    role: meta.getAttribute("data-role"),
    userId: meta.getAttribute("data-user-id"),
    name: meta.getAttribute("data-name"),
    iceServers: JSON.parse(meta.getAttribute("data-ice-servers") || "[]"),
  };

  var isHost = CFG.role === "host";

  /* ---------------- DOM refs ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var chip = $("connChip");
  var connText = $("connText");
  var shareState = $("shareState");
  var screenNote = $("screenNote");
  var toastEl = $("toast");
  var localVideo = $("localVideo");
  var remoteVideo = $("remoteVideo");
  var shareModal = $("shareModal");

  /* ---------------- WebRTC state ---------------- */
  var pc = null;
  var localStream = null;
  var sharing = false;
  var pendingCandidates = [];
  var gotOffer = false;
  var toastTimer = null;

  function socketioClient() {
    return io();
  }

  var socket = socketioClient();

  /* ---------------- Helpers ---------------- */
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.hidden = true;
    }, 4000);
  }

  function note(msg) {
    var text = typeof msg === "string" ? msg : "";
    if (screenNote) {
      screenNote.textContent = text;
    }
  }

  function setChip(on, text) {
    chip.classList.toggle("on", !!on);
    connText.textContent = text;
  }

  function setShareState(text) {
    if (shareState) shareState.textContent = text;
  }

  function newPeerConnection() {
    var conn = new RTCPeerConnection({ iceServers: CFG.iceServers });
    conn.onicecandidate = function (e) {
      if (e.candidate) {
        socket.emit("rtc-candidate", {
          code: CFG.code,
          payload: e.candidate,
        });
      }
    };
    conn.onconnectionstatechange = function () {
      if (conn.connectionState === "connected") {
        setShareState(isHost ? "Receiving live" : "Sharing live");
        note("Secure peer-to-peer connection established.");
      } else if (
        conn.connectionState === "failed" ||
        conn.connectionState === "disconnected"
      ) {
        if (sharing || isHost) {
          setShareState("Connection lost");
          note("Connection lost. Stop and restart sharing to reconnect.");
        }
      } else if (conn.connectionState === "closed") {
        setShareState("Not sharing");
      }
    };
    return conn;
  }

  function closePeer() {
    if (pc) {
      try { pc.close(); } catch (e) { /* ignore */ }
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(function (t) { t.stop(); });
      localStream = null;
    }
    pendingCandidates = [];
    gotOffer = false;
  }

  function cleanupShare() {
    sharing = false;
    closePeer();
    if ($("startShareBtn")) $("startShareBtn").disabled = false;
    if ($("stopShareBtn")) $("stopShareBtn").disabled = true;
    if (localVideo) {
      localVideo.hidden = true;
      localVideo.srcObject = null;
    }
    hideShareModal();
  }

  function hideShareModal() {
    if (shareModal) shareModal.hidden = true;
  }

  /* ---------------- Guest: start / stop sharing ---------------- */
  async function startSharing() {
    if (sharing) return;
    hideShareModal();

    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
      } catch (err) {
        note("Screen share was cancelled. You must allow screen access to share.");
        setShareState("Not sharing");
        return;
      }
    } else {
      note("Screen sharing is not supported by this browser.");
      return;
    }

    localStream.getVideoTracks()[0].addEventListener("ended", function () {
      cleanupShare();
      socket.emit("share-stopped", { code: CFG.code });
      setShareState("Not sharing");
      note("Screen sharing stopped.");
    });

    sharing = true;
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.hidden = false;
    }
    if ($("startShareBtn")) $("startShareBtn").disabled = true;
    if ($("stopShareBtn")) $("stopShareBtn").disabled = false;
    setShareState("Sharing");
    note("You are sharing your screen. Everything you show is visible to the technician.");

    closePeer();
    pc = newPeerConnection();
    localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });

    socket.emit("share-started", { code: CFG.code });

    try {
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("rtc-offer", { code: CFG.code, payload: pc.localDescription });
    } catch (err) {
      note("Could not start the video connection: " + err.message);
      cleanupShare();
    }
  }

  function stopSharing() {
    if (!sharing) return;
    socket.emit("share-stopped", { code: CFG.code });
    cleanupShare();
    setShareState("Not sharing");
    note("You stopped sharing your screen.");
  }

  /* ---------------- Host: receive the stream ---------------- */
  async function handleOffer(payload) {
    if (pc) {
      try { pc.close(); } catch (e) { /* ignore */ }
      pendingCandidates = [];
      gotOffer = false;
    }
    pc = newPeerConnection();
    if (remoteVideo) {
      pc.ontrack = function (e) {
        if (remoteVideo && e.streams && e.streams[0]) {
          remoteVideo.srcObject = e.streams[0];
          remoteVideo.hidden = false;
          if ($("videoPlaceholderHost")) $("videoPlaceholderHost").hidden = true;
          setShareState("Receiving live");
          showToast("Customer screen live. You can now see their screen.");
        }
      };
      pc.onremovetrack = function () {
        remoteVideo.srcObject = null;
        if ($("videoPlaceholderHost")) $("videoPlaceholderHost").hidden = false;
        setShareState("Not sharing");
      };
    }

    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      await pc.setRemoteDescription(payload);
      gotOffer = true;
      while (pendingCandidates.length) {
        await pc.addIceCandidate(pendingCandidates.shift());
      }
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("rtc-answer", { code: CFG.code, payload: pc.localDescription });
    } catch (err) {
      note("Could not establish the video connection: " + err.message);
      setShareState("Not sharing");
    }
  }

  async function addCandidate(candidate) {
    if (!candidate) return;
    try {
      var cand = candidate instanceof RTCIceCandidate ? candidate : new RTCIceCandidate(candidate);
      if (pc && gotOffer && pc.remoteDescription) {
        await pc.addIceCandidate(cand);
      } else {
        pendingCandidates.push(cand);
      }
    } catch (err) {
      /* ignore benign ICE errors */
    }
  }

  /* ---------------- Copy code ---------------- */
  function copyCode() {
    var code = CFG.code;
    var done = function () { showToast("Session code copied to clipboard."); };
    var fallback = function () {
      var ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, fallback);
    } else {
      fallback();
    }
  }

  /* ---------------- Chat ---------------- */
  var chatForm = $("chatForm");
  var chatInput = $("chatInput");
  var chatLog = $("chatLog");

  function scrollChat() {
    if (chatLog) chatLog.scrollTop = chatLog.scrollHeight;
  }

  function addChatMessage(msg) {
    if (!chatLog) return;
    var li = document.createElement("li");
    li.className = "chat-msg " + (msg.role === CFG.role ? "me" : "them");
    var metaSpan = document.createElement("span");
    metaSpan.className = "chat-meta";
    metaSpan.textContent = msg.sender + " · " + msg.time;
    var textSpan = document.createElement("span");
    textSpan.className = "chat-text";
    textSpan.textContent = msg.text;
    li.appendChild(metaSpan);
    li.appendChild(textSpan);
    chatLog.appendChild(li);
    scrollChat();
  }

  if (chatForm) {
    chatForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = chatInput.value.trim();
      if (!text) return;
      socket.emit("chat-message", { code: CFG.code, text: text });
      chatInput.value = "";
      chatInput.focus();
    });
  }

  /* ---------------- Files ---------------- */
  var uploadForm = $("uploadForm");
  var fileInput = $("fileInput");
  var sendFileBtn = $("sendFileBtn");
  var fileList = $("fileList");

  function formatSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function prependFileItem(f) {
    if (!fileList) return;
    var existing = $("file-" + f.id);
    if (existing) { existing.remove(); }
    var li = document.createElement("li");
    li.className = "file-item";
    li.id = "file-" + f.id;
    var nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    nameSpan.textContent = f.name;
    var metaSpan = document.createElement("span");
    metaSpan.className = "file-meta";
    metaSpan.textContent = f.by + " · " + f.time + " · " + formatSize(f.size);
    var dl = document.createElement("a");
    dl.className = "btn btn-sm btn-primary";
    dl.href = "/session/" + CFG.code + "/files/" + f.id + "/download";
    dl.textContent = "Download";
    li.appendChild(nameSpan);
    li.appendChild(metaSpan);
    li.appendChild(dl);
    fileList.prepend(li);
  }

  if (fileInput) {
    fileInput.addEventListener("change", function () {
      if (sendFileBtn) sendFileBtn.disabled = !fileInput.files.length;
    });
  }

  if (uploadForm) {
    uploadForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var file = fileInput.files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) {
        showToast("File is too large. Max size is 25 MB.");
        return;
      }
      sendFileBtn.disabled = true;
      var fd = new FormData();
      fd.append("file", file);

      fetch("/session/" + CFG.code + "/upload", { method: "POST", body: fd })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          if (result.ok && result.data.file) {
            var f = result.data.file;
            f.by = CFG.name;
            f.time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            prependFileItem(f);
            showToast("File sent.");
          } else {
            showToast(result.data.error || "Upload failed.");
          }
        })
        .catch(function () { showToast("Upload failed. Is the server running?"); })
        .finally(function () {
          if (fileInput) {
            fileInput.value = "";
            sendFileBtn.disabled = true;
          }
        });
    });
  }

  /* ---------------- Tabs ---------------- */
  var tabs = [["tabChat", "paneChat"], ["tabFiles", "paneFiles"]];
  tabs.forEach(function (pair) {
    var tab = $(pair[0]);
    var pane = $(pair[1]);
    if (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (p) {
          $(p[0]).classList.toggle("active", p[0] === pair[0]);
          $(p[1]).classList.toggle("active", p[0] === pair[0]);
        });
      });
    }
  });

  /* ---------------- End session ---------------- */
  function goEnded() {
    window.location.href = "/dashboard";
  }

  /* ---------------- Socket events ---------------- */
  socket.on("connect", function () {
    socket.emit("join-room", {
      code: CFG.code,
      role: CFG.role,
      user_id: CFG.userId,
    });
  });

  socket.on("join-error", function (data) {
    showToast(data && data.message ? data.message : "Could not join session.");
    setTimeout(goEnded, 1500);
  });

  socket.on("joined", function (data) {
    if (isHost) {
      if (data.partner) {
        setChip(true, "Customer connected");
      } else {
        setChip(false, "Waiting for customer…");
      }
    } else {
      setChip(true, "Connected to technician");
    }
  });

  socket.on("peer-status", function (data) {
    if (!data) return;
    if (data.connected === false) {
      if (isHost) {
        if (data.role === "guest") setChip(false, "Customer disconnected");
      } else {
        if (data.role === "host") {
          setChip(false, "Technician disconnected");
          closePeer();
        }
      }
      if (!isHost && data.role === "guest") {
        closePeer();
        setShareState("Not sharing");
      }
      return;
    }
    if (data.connected === true) {
      if (isHost && data.role === "guest") {
        setChip(true, "Customer connected");
      } else if (!isHost && data.role === "host") {
        setChip(true, "Connected to technician");
      }
    }
    if (typeof data.sharing === "boolean" && isHost) {
      setShareState(data.sharing ? "Customer is sharing" : "Not sharing");
    }
  });

  socket.on("chat-message", function (msg) {
    addChatMessage(msg);
  });

  socket.on("file-shared", function (f) {
    prependFileItem(f);
    showToast(f.by + " sent a file.");
  });

  /* consent + share flow */
  socket.on("share-request", function (data) {
    if (shareModal) {
      var h = shareModal.querySelector("h3");
      if (h) h.textContent = (data && data.host_name ? data.host_name + " " : "The technician ") + "is requesting your screen";
      shareModal.hidden = false;
    }
  });

  /* RTC signaling */
  socket.on("rtc-offer", function (data) {
    handleOffer(data && data.payload);
  });

  socket.on("rtc-answer", async function (data) {
    if (!pc || !data || !data.payload) return;
    try {
      await pc.setRemoteDescription(data.payload);
      gotOffer = true;
      while (pendingCandidates.length) {
        await pc.addIceCandidate(pendingCandidates.shift());
      }
    } catch (err) { /* ignore late answers */ }
  });

  socket.on("rtc-candidate", function (data) {
    if (data && data.payload) addCandidate(data.payload);
  });

  socket.on("session-ended", function () {
    showToast("This session has ended.");
    setTimeout(goEnded, 1200);
  });

  socket.on("disconnect", function () {
    if (isHost) setChip(false, "Reconnecting…");
  });

  /* ---------------- Buttons ---------------- */
  if ($("copyBtn")) $("copyBtn").addEventListener("click", copyCode);
  if ($("startShareBtn")) $("startShareBtn").addEventListener("click", startSharing);
  if ($("stopShareBtn")) $("stopShareBtn").addEventListener("click", stopSharing);
  if ($("approveShareBtn")) $("approveShareBtn").addEventListener("click", startSharing);
  if ($("declineShareBtn")) $("declineShareBtn").addEventListener("click", hideShareModal);

  scrollChat();
})();