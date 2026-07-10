declare module "nodemailer" {
  export type Transporter = {
    sendMail(message: Record<string, unknown>): Promise<unknown>;
    verify(): Promise<unknown>;
  };

  export function createTransport(options: Record<string, unknown>): Transporter;
}
