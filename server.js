const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const SECRET_KEY = process.env.SECRET_KEY || "super-secret-professor-key";

// Increase payload limit to accept high-res Base64 map PNGs
app.use(express.json({ limit: '50mb' }));

let mapState = {
    centerX: 0,
    centerZ: 0,
    radius: 512,
    imageBase64: null,
    border: { centerX: 0, centerZ: 0, size: 1024 },
    players: []
};

// Auth Middleware for Minecraft Plugin requests
function authenticate(req, res, next) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${SECRET_KEY}`) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
}

// Receive full map PNG from /maprender command
app.post('/api/map-upload', authenticate, (req, res) => {
    const { centerX, centerZ, radius, image } = req.body;
    mapState.centerX = centerX;
    mapState.centerZ = centerZ;
    mapState.radius = radius;
    mapState.imageBase64 = image;

    broadcast({ type: 'MAP_UPDATE', centerX, centerZ, radius, image });
    res.sendStatus(200);
});

// Receive 1-second realtime telemetry (players + world border)
app.post('/api/telemetry', authenticate, (req, res) => {
    mapState.border = req.body.border;
    mapState.players = req.body.players;

    broadcast({
        type: 'TELEMETRY',
        border: mapState.border,
        players: mapState.players
    });
    res.sendStatus(200);
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

wss.on('connection', (ws) => {
    // Immediately send current map and player state to new web visitors
    ws.send(JSON.stringify({ type: 'INIT', state: mapState }));
});

// Serve the interactive Map Frontend
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>ChunkyX Live World Map</title>
    <style>
        body { margin: 0; background: #1a1a1a; color: #fff; font-family: monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
        #hud { position: fixed; top: 16px; left: 16px; background: rgba(0,0,0,0.8); padding: 12px 16px; border: 2px solid #c6b08b; border-radius: 4px; z-index: 10; }
        /* Classic Minecraft Paper Map Frame styling */
        #map-frame { position: relative; padding: 18px; background: #d6c198; border: 6px solid #4a3c28; box-shadow: inset 0 0 0 4px #b89f72, 0 12px 30px rgba(0,0,0,0.7); }
        canvas { image-rendering: pixelated; display: block; background: #202060; cursor: grab; }
        canvas:active { cursor: grabbing; }
    </style>
</head>
<body>
    <div id="hud">
        <strong>ChunkyX Live Map</strong><br>
        <span id="coords">Hover map for X/Z</span><br>
        <span id="player-count">Players Online: 0</span>
    </div>
    <div id="map-frame">
        <canvas id="mapCanvas" width="768" height="768"></canvas>
    </div>

    <script>
        const canvas = document.getElementById('mapCanvas');
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        let mapImg = new Image();
        let state = { centerX: 0, centerZ: 0, radius: 512, border: { centerX: 0, centerZ: 0, size: 1024 }, players: [] };
        let zoom = 1, panX = 0, panY = 0, isDragging = false, startX = 0, startY = 0;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + location.host + '/ws');

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'INIT') {
                state = data.state;
                if (state.imageBase64) mapImg.src = 'data:image/png;base64,' + state.imageBase64;
            } else if (data.type === 'MAP_UPDATE') {
                state.centerX = data.centerX;
                state.centerZ = data.centerZ;
                state.radius = data.radius;
                mapImg.src = 'data:image/png;base64,' + data.image;
            } else if (data.type === 'TELEMETRY') {
                state.border = data.border;
                state.players = data.players;
                document.getElementById('player-count').innerText = 'Players Online: ' + state.players.length;
            }
            draw();
        };

        mapImg.onload = () => draw();

        function worldToCanvas(wx, wz) {
            const normX = (wx - (state.centerX - state.radius)) / (state.radius * 2);
            const normZ = (wz - (state.centerZ - state.radius)) / (state.radius * 2);
            return { x: normX * canvas.width, y: normZ * canvas.height };
        }

        function draw() {
            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.translate(panX, panY);
            ctx.scale(zoom, zoom);

            // 1. Draw pre-generated terrain
            if (mapImg.src) {
                ctx.drawImage(mapImg, 0, 0, canvas.width, canvas.height);
            }

            // 2. Draw WorldBorder box
            if (state.border) {
                const half = state.border.size / 2;
                const tl = worldToCanvas(state.border.centerX - half, state.border.centerZ - half);
                const br = worldToCanvas(state.border.centerX + half, state.border.centerZ + half);
                ctx.strokeStyle = '#ff3333';
                ctx.lineWidth = 2 / zoom;
                ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
            }

            // 3. Draw Live Players
            state.players.forEach(p => {
                const pos = worldToCanvas(p.x, p.z);
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 1.5 / zoom;

                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 5 / zoom, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();

                ctx.font = (12 / zoom) + 'px monospace';
                ctx.fillStyle = '#ffff55';
                ctx.fillText(p.name, pos.x + (8 / zoom), pos.y + (4 / zoom));
            });

            ctx.restore();
        }

        // Zoom & Pan controls
        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            zoom = Math.max(1, Math.min(8, zoom * (e.deltaY < 0 ? 1.15 : 0.85)));
            draw();
        });
        canvas.addEventListener('mousedown', e => { isDragging = true; startX = e.clientX - panX; startY = e.clientY - panY; });
        window.addEventListener('mouseup', () => isDragging = false);
        window.addEventListener('mousemove', e => {
            if (isDragging) { panX = e.clientX - startX; panY = e.clientY - startY; draw(); }
        });
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ChunkyMap Web Server running on port ${PORT}`));
