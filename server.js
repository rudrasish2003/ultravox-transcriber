import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });       // Frontend
const twilioWss = new WebSocketServer({ noServer: true }); // Twilio

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let frontendSockets = [];

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

wss.on('connection', (socket) => {
  console.log('✅ Frontend WebSocket connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
app.post('/call', async (req, res) => {
  const { to } = req.body;

  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/twiml`,
      to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST',
      statusCallback: `https://${req.headers.host}/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    console.log(`📞 Outgoing call initiated to ${to}`);
    res.json({ success: true, sid: call.sid });
  } catch (error) {
    console.error('❌ Call initiation error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const start = response.start();
  start.stream({
    url: `wss://${req.headers.host}/twilio`
  });

  response.say('This is a test call. Speak after the beep.');
  response.pause({ length: 60 });

  console.log('🧾 TwiML returned with streaming + pause');

  res.type('text/xml');
  res.send(response.toString());
});

app.post('/status', (req, res) => {
  const { CallSid, CallStatus, From, To } = req.body;

  console.log('📶 Call Status Webhook Hit');
  console.log(`SID: ${CallSid}`);
  console.log(`From: ${From}, To: ${To}`);
  console.log(`Status: ${CallStatus}`);

  const statusPayload = {
    type: 'status',
    status: CallStatus,
    sid: CallSid,
    from: From,
    to: To
  };

  let sent = false;
  frontendSockets.forEach(sock => {
    if (sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(statusPayload));
      sent = true;
    }
  });

  if (!sent) console.log('⚠️ No frontend sockets to send status to');

  res.sendStatus(200);
});

const upgradedSockets = new WeakSet();

server.on('upgrade', (req, socket, head) => {
  if (upgradedSockets.has(socket)) {
    console.warn('⚠️ Duplicate upgrade attempt');
    socket.destroy();
    return;
  }

  upgradedSockets.add(socket);
  const pathname = req.url;

  if (pathname === '/twilio') {
    console.log('🔌 WebSocket upgrade for /twilio');
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit('connection', ws, req);
    });
  } else if (pathname === '/frontend') {
    console.log('🔌 WebSocket upgrade for /frontend');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

twilioWss.on('connection', (twilioSocket) => {
  console.log('🔁 Twilio WebSocket connected');

  const uv = new WebSocket('wss://api.ultravox.ai/realtime', {
    headers: {
      Authorization: `Bearer ${process.env.ULTRAVOX_TOKEN}`
    }
  });

  uv.on('open', () => {
    console.log('🌐 Ultravox WebSocket opened');

    twilioSocket.on('message', (msg) => {
      try {
        const json = JSON.parse(msg);
        if (json.event === 'media') {
          const audio = Buffer.from(json.media.payload, 'base64');
          uv.send(audio);
          console.log('🎙️ Sent audio to Ultravox');
        }
      } catch (err) {
        console.error('⚠️ Failed to parse Twilio media:', err.message);
      }
    });

    uv.on('message', (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'transcript' && parsed.transcript?.text) {
          console.log('📝 Transcript:', parsed.transcript.text);
          frontendSockets.forEach(sock => {
            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({ type: 'transcript', text: parsed.transcript.text }));
              console.log('📤 Transcript sent to frontend');
            }
          });
        }
      } catch (err) {
        console.error('⚠️ Failed to parse Ultravox msg:', err.message);
      }
    });
  });

  uv.on('error', (err) => {
    console.error('❌ Ultravox WebSocket error:', err.message);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
