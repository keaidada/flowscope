/**
 * Vite plugin to sync the browser-side SQLite database to a local file.
 * During dev, the browser POSTs the database to /dev/save-db,
 * and it gets saved to project root as flowscope.db for inspection.
 */
import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

const DB_FILENAME = 'flowscope.db';
const SAVE_PATH = '/dev/save-db';
const GET_PATH = '/dev/db';

export function devDbSync(): Plugin {
  let dbFilePath: string;

  return {
    name: 'flowscope-dev-db-sync',
    apply: 'serve',
    configureServer(server) {
      dbFilePath = path.resolve(server.config.root, '..', DB_FILENAME);

      // The "database" lifecycle event fires before configureServer
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        if (req.method === 'POST' && url.pathname === SAVE_PATH) {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const data = Buffer.concat(chunks);
              fs.writeFileSync(dbFilePath, data);
              console.log(`[dev-db] Saved ${(data.length / 1024).toFixed(1)} KB to ${dbFilePath}`);
              res.writeHead(200);
              res.end('ok');
            } catch (err) {
              console.error('[dev-db] Write failed:', err);
              res.writeHead(500);
              res.end('write failed');
            }
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === GET_PATH) {
          try {
            if (!fs.existsSync(dbFilePath)) {
              res.writeHead(404);
              res.end('no db saved yet — run analysis first');
              return;
            }
            const data = fs.readFileSync(dbFilePath);
            res.writeHead(200, {
              'Content-Type': 'application/x-sqlite3',
              'Content-Disposition': `attachment; filename="${DB_FILENAME}"`,
              'Content-Length': data.length,
            });
            res.end(data);
          } catch (err) {
            console.error('[dev-db] Read failed:', err);
            res.writeHead(500);
            res.end('read failed');
          }
          return;
        }

        next();
      });
    },
  };
}
