/** ts-resolve 훅을 붙인다. `node --import ./scripts/ts-register.mjs` 로 쓴다 */
import { register } from "node:module";
register("./ts-resolve.mjs", import.meta.url);
