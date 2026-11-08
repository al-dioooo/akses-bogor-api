import { describe, expect, it } from "vitest";
import { accountDeletedEmail, codeEmail, logMailer, resendMailer } from "../src/email/mailer.js";

describe("codeEmail", () => {
  it("puts the code in the subject and says how long it lasts", () => {
    const email = codeEmail("sari@contoh.id", "048213");
    expect(email.subject).toBe("Kode masuk AksesBogor: 048213");
    expect(email.text).toContain("10 menit");
    expect(email.html).toContain('lang="id"');
    expect(email.html).not.toMatch(/<img|<a /);
  });
});

describe("accountDeletedEmail", () => {
  it("explains what stays published", () => {
    const email = accountDeletedEmail("sari@contoh.id");
    expect(email.to).toBe("sari@contoh.id");
    expect(email.text).toContain("tanpa nama Anda");
  });
});

describe("resendMailer", () => {
  it("posts the email to the Resend API with the key and sender", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = resendMailer({
      apiKey: "re_tes",
      from: "AksesBogor <masuk@kirim.contoh.id>",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return Response.json({ id: "email-1" });
      },
    });
    await mailer(codeEmail("sari@contoh.id", "048213"));
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer re_tes");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      from: "AksesBogor <masuk@kirim.contoh.id>",
      to: ["sari@contoh.id"],
      subject: "Kode masuk AksesBogor: 048213",
    });
  });

  it("throws when Resend refuses the email", async () => {
    const mailer = resendMailer({ apiKey: "re_tes", from: "a@b.id", fetch: async () => new Response("{}", { status: 422 }) });
    await expect(mailer(codeEmail("sari@contoh.id", "048213"))).rejects.toThrow(/422/);
  });
});

describe("logMailer", () => {
  it("prints the email instead of sending it", async () => {
    const lines: string[] = [];
    await logMailer((line) => lines.push(line))(codeEmail("sari@contoh.id", "048213"));
    expect(lines[0]).toContain("tidak dikirim");
    expect(lines[0]).toContain("048213");
  });
});
