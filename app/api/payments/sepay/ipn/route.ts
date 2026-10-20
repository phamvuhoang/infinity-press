import { handleSepayIpn } from "@/lib/commerce/sepay-ipn";

// SePay's payment notification. Authenticated by the X-Secret-Key header; 404 when SePay is not
// configured on this deployment.
export async function POST(request: Request) {
  return handleSepayIpn(request);
}
