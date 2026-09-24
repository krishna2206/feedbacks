/**
 * Outgoing email. SMTP is optional: without it, messages (and their links) are printed
 * to the API logs so a self-hosted instance works out of the box.
 */
import nodemailer from "nodemailer";
import { env } from "./env";

const transport = env.smtp
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    })
  : null;

export const emailEnabled = transport !== null;

export async function sendEmail(msg: { to: string; subject: string; text: string }) {
  if (!transport || !env.smtp) {
    console.log(`\n[email] (SMTP not configured) to=${msg.to}\n  subject: ${msg.subject}\n  ${msg.text.replace(/\n/g, "\n  ")}\n`);
    return;
  }
  await transport.sendMail({ from: env.smtp.from, ...msg });
}
