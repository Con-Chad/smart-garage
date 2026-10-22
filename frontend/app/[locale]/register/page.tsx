import { setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isRegistrationOpen } from "@/lib/services/auth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export default async function RegisterPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  let user = null;
  try {
    user = await getCurrentUser();
  } catch {
    user = null;
  }

  if (user) {
    redirect(`/${locale}`);
  }

  // The form is only shown while registration is open (first account, or
  // REGISTRATION_ENABLED=true); the server action re-checks on submit.
  return <RegisterForm closed={!(await isRegistrationOpen())} />;
}
