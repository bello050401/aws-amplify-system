import LoginForm from "./LoginForm";
import { redirect } from "next/navigation";

export default async function LoginPage({searchParams: pendingSearchParams}: {searchParams: Promise<{error?: string}>}) {
  if(process.env.BELLO_DEVICE_SECURITY === "enforced")redirect("/security?returnTo=%2Finventory");
  const searchParams = await pendingSearchParams;

  return <LoginForm searchParams={searchParams} />;
}
