import { notFound } from "next/navigation";
import { PasswordAuthPage } from "./password-page";

/** Email + password sign-up/sign-in for local testing only — returns 404 in production. */
export default function Page() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <PasswordAuthPage />;
}
