import LoginForm from "./LoginForm";

export default async function LoginPage({searchParams: pendingSearchParams}: {searchParams: Promise<{error?: string}>}) {
  const searchParams = await pendingSearchParams;

  return <LoginForm searchParams={searchParams} />;
}
