/**
 * 확장자 없는 상대 import 를 `.ts` 로 이어준다.
 *
 * Node 22+ 는 TypeScript 파일을 읽지만 경로 해석까지 해주지는 않는다. `src/lib` 는
 * Next 의 번들러를 전제로 `./db` 처럼 확장자 없이 쓰는데, 러너에서 그 파일을 직접
 * 불러 쓰려면 이 다리가 필요하다.
 *
 * 이게 없으면 스크립트마다 로직을 복제하게 되고, 그러면 한쪽만 고쳐 조용히 어긋난다.
 *
 * 사용: node --import ./scripts/ts-register.mjs scripts/무언가.mjs
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".")) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return await nextResolve(`${specifier}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
