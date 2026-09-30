import { redirect } from "next/navigation";

/** 상품 트렌드는 네이버 블로그(제품 후기 탭) 안으로 옮겼다. 예전 주소로 오면 그리로 보낸다 */
export default function ProductsPage() {
  redirect("/visit?kind=product");
}
