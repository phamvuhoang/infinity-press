import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AskForm } from "@/components/account/ask-form";
import { initialAdminFormState } from "@/lib/catalog/form";

const copy = {
  title: "Ask the author",
  about: "About: {title}",
  bodyLabel: "Your question",
  counter: "{count}/500",
  send: "Send question",
  sent: "Sent.",
  errors: { tooMany: "Too many.", targetMissing: "Gone.", failed: "Could not send.", body: "Write a question.", target: "Pick one." },
};
const target = { kind: "book" as const, id: "b1", title: "Harbour Lights" };
const noop = vi.fn(async () => initialAdminFormState);

afterEach(cleanup);

describe("AskForm", () => {
  it("names the target, limits the body, and counts characters", async () => {
    render(<AskForm action={noop} copy={copy} target={target} />);
    expect(screen.getByText("About: Harbour Lights")).toBeInTheDocument();
    const body = screen.getByLabelText("Your question");
    expect(body).toHaveAttribute("maxlength", "500");
    expect(screen.getByText("0/500")).toBeInTheDocument();
    await userEvent.type(body, "ab");
    expect(screen.getByText("2/500")).toBeInTheDocument();
  });

  it("posts the question with the book id hidden field", async () => {
    const action = vi.fn(async () => initialAdminFormState);
    render(<AskForm action={action} copy={copy} target={target} />);
    await userEvent.type(screen.getByLabelText("Your question"), "Why?");
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    const sent = (action.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(sent.get("body")).toBe("Why?");
    expect(sent.get("bookId")).toBe("b1");
    expect(sent.get("ideaId")).toBeNull();
  });

  it("posts an idea target as ideaId", async () => {
    const action = vi.fn(async () => initialAdminFormState);
    render(<AskForm action={action} copy={copy} target={{ kind: "idea", id: "i1", title: "Why?" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    const sent = (action.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(sent.get("ideaId")).toBe("i1");
    expect(sent.get("bookId")).toBeNull();
  });

  it.each([
    ["too_many", "Too many."],
    ["target_missing", "Gone."],
    ["failed", "Could not send."],
  ])("maps the %s key to dictionary copy", async (formError, text) => {
    const action = vi.fn(async () => ({ fieldErrors: {}, formError, savedAt: null }));
    render(<AskForm action={action} copy={copy} target={target} />);
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("maps field error keys to customer copy, never the schema's English", async () => {
    const action = vi.fn(async () => ({ fieldErrors: { body: "Enter your question.", target: "Choose a target." }, formError: null, savedAt: null }));
    render(<AskForm action={action} copy={copy} target={target} />);
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText("Write a question.")).toBeInTheDocument();
    expect(screen.getByText("Pick one.")).toBeInTheDocument();
    expect(screen.queryByText("Enter your question.")).not.toBeInTheDocument();
  });

  it("shows the sent notice and clears the body on success", async () => {
    const action = vi.fn(async () => ({ fieldErrors: {}, formError: null, savedAt: 1 }));
    render(<AskForm action={action} copy={copy} target={target} />);
    await userEvent.type(screen.getByLabelText("Your question"), "Why?");
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent.");
    expect(screen.getByLabelText("Your question")).toHaveValue("");
  });

  it("hides the sent notice once the reader types again", async () => {
    const action = vi.fn(async () => ({ fieldErrors: {}, formError: null, savedAt: 1 }));
    render(<AskForm action={action} copy={copy} target={target} />);
    await userEvent.type(screen.getByLabelText("Your question"), "Why?");
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Your question"), "N");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
