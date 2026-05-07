import { redirect } from "next/navigation";
import { readAuthSnapshot } from "@/lib/copilot-auth";
import OnboardingFlow from "./OnboardingFlow";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  // If you're already signed in, you don't belong here.
  const auth = await readAuthSnapshot();
  if (auth.authenticated) {
    redirect("/");
  }
  return <OnboardingFlow />;
}
