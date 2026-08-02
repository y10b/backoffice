/**
 * dev 서버가 떠 있는데 `npm run build` 를 돌리면 둘이 같은 .next 를 쓰면서 깨진다.
 * 그 뒤로 dev 는 "Cannot find module './chunks/vendor-chunks/next.js'" 로 500 만 뱉는데,
 * 원인이 빌드라는 걸 알아채기 어려워 한참 헤매게 된다. 미리 막는다.
 */
import net from "node:net";

const PORT = 3939;

const inUse = await new Promise((resolve) => {
  const sock = net.connect({ port: PORT, host: "127.0.0.1" });
  sock.setTimeout(1200);
  sock.on("connect", () => (sock.destroy(), resolve(true)));
  sock.on("error", () => resolve(false));
  sock.on("timeout", () => (sock.destroy(), resolve(false)));
});

if (inUse) {
  console.error(
    `\n포트 ${PORT} 에 dev 서버가 떠 있습니다.\n` +
      "빌드하면 .next 가 깨져 dev 가 500 을 뱉습니다. dev 를 먼저 끄고 다시 시도하세요.\n",
  );
  process.exit(1);
}
