// Vercel serverless entry point: every non-static route is rewritten here (see vercel.json).
import { createHandler } from '../server.js';
const { handler } = createHandler();
export default handler;
