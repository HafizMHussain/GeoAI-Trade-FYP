// Vercel serverless entry point.
// Forwards every /api/* request to the Express mock backend, which already
// defines all the routes the frontend calls. The Express app is exported from
// mock-backend/server.js and does not open its own listener under Vercel.
import app from '../mock-backend/server.js';

export default app;
