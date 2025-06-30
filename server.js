// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const WebSocket = require('ws');
const twilio = require('twilio');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const twilioWss = new WebSocket.Server({ noServer: true });

const __dirname = path.resolve();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let frontendSockets = [];

// Serve frontend
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Frontend WebSocket for transcript updates
wss.on('connection', (socket) => {
  console.log('✅ Frontend connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

// Outgoing call endpoint
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
app.post('/call', async (req, res) => {
  const { to } = req.body;
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/twiml`,
      to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST'
    });
    res.json({ success: true, sid: call.sid });
  } catch (error) {
    console.error('Call error:', error);
    res.status(500).json({ error: error.message });
  }
});

// TwiML dynamic generation route
app.post('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const start = response.start();
  start.stream({
    url: `wss://${req.headers.host}/twilio`
  });

  response.say('This is a test call. Speak after the beep.');

  res.type('text/xml');
  res.send(response.toString());
});

// WebSocket upgrade routing
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url;
  if (pathname === '/twilio') {
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit('connection', ws, req);
    });
  }
});

// Twilio <Stream> handler
twilioWss.on('connection', (twilioSocket) => {
  console.log('📞 Twilio connected');

  const uv = new WebSocket('wss://api.ultravox.ai/realtime', {
    headers: {
      Authorization: `Bearer ${process.env.ULTRAVOX_TOKEN}`
    }
  });

  uv.on('open', () => {
    twilioSocket.on('message', (msg) => {
      const json = JSON.parse(msg);
      if (json.event === 'media') {
        const audio = Buffer.from(json.media.payload, 'base64');
        uv.send(audio);
      }
    });

    uv.on('message', (data) => {
      const parsed = JSON.parse(data);
      if (parsed.type === 'transcript' && parsed.transcript?.text) {
        console.log('📝', parsed.transcript.text);
        frontendSockets.forEach(sock => {
          if (sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ text: parsed.transcript.text }));
          }
        });
      }
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
