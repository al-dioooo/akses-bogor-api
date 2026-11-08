// Masuk dengan kode email lewat route sungguhan, untuk tes route yang butuh akun.
import { PRIVACY_POLICY_VERSION } from "../../src/auth/rules.js";
import type { buildApp } from "../../src/app.js";
import type { Email } from "../../src/email/mailer.js";

type App = Awaited<ReturnType<typeof buildApp>>;

export function accounts(app: App, sent: Email[]) {
  let ip = 1;
  const nextIp = () => `192.0.2.${ip++ % 250}`;

  async function signIn(email: string) {
    const remoteAddress = nextIp();
    await app.inject({ method: "POST", url: "/auth/code", payload: { email }, remoteAddress });
    const code = sent.at(-1)!.subject.slice(-6);
    const res = await app.inject({ method: "POST", url: "/auth/code/verify", payload: { email, code }, remoteAddress });
    return res.json() as { token: string; user: { id: string } };
  }

  /** Akun yang sudah melengkapi nama dan persetujuan Kebijakan Privasi. */
  async function reporter(email: string, displayName = "Pelapor") {
    const session = await signIn(email);
    await app.inject({
      method: "POST",
      url: "/me/complete",
      headers: { authorization: `Bearer ${session.token}` },
      payload: { displayName, acceptPrivacyPolicy: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION },
    });
    return session;
  }

  return { signIn, reporter };
}
