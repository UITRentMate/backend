import { app } from './app';
import { PORT } from './config/env';
import { startPhase3Timers, stopPhase3Timers } from './infrastructure/scheduler/phase3-timers';

const server = app.listen(PORT, () => {
  startPhase3Timers();
  console.log(`RentMate Backend server running on http://localhost:${PORT}`);
});

server.on('close', () => {
  stopPhase3Timers();
});

export default server;
