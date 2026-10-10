const normalize = (email: string) => email.trim().toLowerCase();

// ALLOWED_EMAILS is a comma-separated list.
export const allowedEmails = (setting: string) =>
  setting
    .split(",")
    .map(normalize)
    .filter((email) => email !== "");

// An email is compared ignoring case and the spaces around it.
export const isAllowed = (setting: string, email: string) =>
  allowedEmails(setting).includes(normalize(email));
