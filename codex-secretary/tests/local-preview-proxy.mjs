import http from 'node:http';
import net from 'node:net';

const listenPort = Number(process.env.PREVIEW_PORT ?? 8088);
const webPort = Number(process.env.PREVIEW_WEB_PORT ?? 3000);
const apiPort = Number(process.env.PREVIEW_API_PORT ?? 4511);

const server = http.createServer((request, response) => {
  const targetPort = request.url?.startsWith('/api/') ? apiPort : webPort;
  const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: request.url, method: request.method, headers: request.headers }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502); response.end('preview upstream unavailable'); });
  request.pipe(upstream);
});

server.on('upgrade', (request, socket, head) => {
  const upstream = net.connect(apiPort, '127.0.0.1', () => {
    const headers = Object.entries(request.headers).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n');
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
});

server.listen(listenPort, '127.0.0.1', () => process.stdout.write(`preview proxy on http://127.0.0.1:${listenPort}\n`));
