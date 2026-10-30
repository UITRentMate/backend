import { app } from './app';
import { PORT } from './config/env';

const server = app.listen(PORT, () => {
  console.log(`RentMate Backend server running on http://localhost:${PORT}`);
});

export default server;
