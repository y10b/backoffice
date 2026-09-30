import { redirect } from "next/navigation";

/** 제철 트렌드는 네이버 블로그(맛집 탭) 안으로 옮겼다. 예전 주소로 오면 그리로 보낸다 */
export default function EatPage() {
  redirect("/visit?kind=restaurant");
}
