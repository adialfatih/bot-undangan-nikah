(function () {
    const logsEl = document.getElementById("logs");
    const qrEl = document.getElementById("qrcode");
    const logoutBtn = document.getElementById("logoutBtn");
    let qrcodeObj = null;

    function log(line) {
        const time = new Date().toLocaleTimeString();
        logsEl.insertAdjacentHTML("beforeend", `<div>[${time}] ${line}</div>`);
        logsEl.scrollTop = logsEl.scrollHeight;
    }

    function renderQR(qr) {
        qrEl.innerHTML = "";
        qrcodeObj = new QRCode(qrEl, {
            text: qr,
            width: 240,
            height: 240,
            correctLevel: QRCode.CorrectLevel.M
        });
    }

    // WebSocket ke server yang sama (port 3005)
    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${wsProto}://${location.host}`);
    ws.onopen = () => log("WebSocket connected");
    ws.onclose = () => log("WebSocket closed");
    ws.onerror = (e) => log("WebSocket error");

    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "qr") {
                renderQR(msg.qr);
                log("QR diterima. Silakan scan via WhatsApp.");
            } else if (msg.type === "log") {
                log(msg.message);
            }
        } catch (e) {
            // ignore
        }
    };

    logoutBtn.addEventListener("click", async () => {
        logoutBtn.disabled = true;
        try {
            const res = await fetch("/logout", { method: "POST" });
            const data = await res.json();
            if (data.ok) {
                log("Logout berhasil. Session & cache dihapus. Menunggu QR baru...");
                // bersihkan QR agar user sadar harus scan ulang
                qrEl.innerHTML = '<span class="muted">Menunggu QR...</span>';
            } else {
                log("Logout gagal: " + (data.error || "unknown"));
            }
        } catch (e) {
            log("Logout error: " + e.message);
        } finally {
            logoutBtn.disabled = false;
        }
    });
    function renderQRDataUrl(dataUrl) {
        qrEl.innerHTML = `<img alt="QR" src="${dataUrl}" width="240" height="240" style="border-radius:8px" />`;
    }

    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "qr_dataurl") {
                renderQRDataUrl(msg.dataUrl);
                log("QR diterima (img). Silakan scan via WhatsApp.");
            } else if (msg.type === "qr") {
                // fallback: butuh QRCode lib. Kalau tidak ada, tetap tampilkan raw text
                if (typeof QRCode !== "undefined") {
                    renderQR(msg.qr);
                } else {
                    qrEl.innerHTML = `<div class="muted" style="word-break:break-all">${msg.qr}</div>`;
                }
                log("QR diterima (raw).");
            } else if (msg.type === "log") {
                log(msg.message);
            }
        } catch { }
    };
})();
