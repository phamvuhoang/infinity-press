type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function readString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function readEmail(
  formData: FormData,
): ValidationResult<{ email: string }> {
  const email = readString(formData, "email").trim().toLowerCase();

  if (!validEmail(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  return { ok: true, data: { email } };
}

export function readCredentials(
  formData: FormData,
): ValidationResult<{ email: string; password: string }> {
  const emailResult = readEmail(formData);
  if (!emailResult.ok) {
    return emailResult;
  }

  const password = readString(formData, "password");
  if (password.length < 8) {
    return {
      ok: false,
      error: "Password must contain at least 8 characters.",
    };
  }

  return { ok: true, data: { email: emailResult.data.email, password } };
}

export function readPasswordUpdate(
  formData: FormData,
): ValidationResult<{ password: string }> {
  const password = readString(formData, "password");
  const confirmPassword = readString(formData, "confirmPassword");

  if (password.length < 8) {
    return {
      ok: false,
      error: "Password must contain at least 8 characters.",
    };
  }

  if (password !== confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }

  return { ok: true, data: { password } };
}
