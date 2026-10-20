import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GiftForm, giftFormMessage } from "@/components/commerce/gift-form";
import type { GiftFormState } from "@/app/[lang]/(account)/checkout/[orderId]/gift-actions";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

const copy = en.checkout.gift;

async function idle(): Promise<GiftFormState> {
  return { status: "idle" };
}

function renderForm(props: Partial<React.ComponentProps<typeof GiftForm>> = {}) {
  return render(<GiftForm copy={copy} gift={null} locked={false} removeAction={idle} saveAction={idle} {...props} />);
}

const pendingGift = { recipientEmail: "friend@example.com", message: "Happy birthday", status: "pending" as const };

describe("giftFormMessage", () => {
  it("maps each state to its own localized message", () => {
    expect(giftFormMessage(copy, { status: "idle" })).toBeNull();
    expect(giftFormMessage(copy, { status: "saved" })).toBeNull();
    expect(giftFormMessage(copy, { status: "unavailable" })).toBe(copy.unavailable);
    expect(giftFormMessage(copy, { status: "invalid", recipientEmail: "invalidEmail", message: null })).toBe(copy.invalidEmail);
    expect(giftFormMessage(copy, { status: "invalid", recipientEmail: null, message: "messageTooLong" })).toBe(copy.messageTooLong);
  });

  it("leads with the address when both fields are wrong, because the address is what the gift needs", () => {
    expect(giftFormMessage(copy, { status: "invalid", recipientEmail: "invalidEmail", message: "messageTooLong" })).toBe(
      copy.invalidEmail,
    );
  });
});

describe("GiftForm", () => {
  it("offers an empty recipient and message for an order with no gift", () => {
    renderForm();

    expect(screen.getByLabelText(copy.emailLabel)).toHaveValue("");
    expect(screen.getByLabelText(copy.messageLabel)).toHaveValue("");
    expect(screen.queryByRole("button", { name: copy.remove })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("states that the purchaser will not receive access", () => {
    renderForm();

    expect(screen.getByText(copy.description)).toBeInTheDocument();
    // Not a copy-edit test: the one thing this block exists to say is that the buyer gets nothing.
    expect(copy.description.toLowerCase()).toContain("will not");
  });

  it("prefills an existing pending gift and offers to remove it", () => {
    renderForm({ gift: pendingGift });

    expect(screen.getByLabelText(copy.emailLabel)).toHaveValue("friend@example.com");
    expect(screen.getByLabelText(copy.messageLabel)).toHaveValue("Happy birthday");
    expect(screen.getByRole("button", { name: copy.remove })).toBeInTheDocument();
    expect(screen.getByText(/friend@example\.com/)).toBeInTheDocument();
  });

  // The raw token and its hash are unreachable from the purchaser's read by construction
  // (get_my_order_gift answers from a view without the hash column). This pins the other half:
  // the component is given only those three fields and renders nothing link-shaped from them.
  it("renders nothing resembling a claim token or link", () => {
    const { container } = renderForm({ gift: pendingGift });

    expect(Object.keys(pendingGift)).toEqual(["recipientEmail", "message", "status"]);
    expect(container.innerHTML).not.toContain("gifts/claim");
    expect(container.innerHTML).not.toContain("token");
  });

  it("shows no editable control once a transfer has been reported", () => {
    renderForm({ gift: pendingGift, locked: true });

    expect(screen.queryByLabelText(copy.emailLabel)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.save })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.remove })).not.toBeInTheDocument();
    expect(screen.getByText(copy.lockedTransfer)).toBeInTheDocument();
    // The reader still sees what they set, because it is still what will be sent.
    expect(screen.getByText(/friend@example\.com/)).toBeInTheDocument();
  });

  it("submits what the reader typed to the save action and shows what it answers", async () => {
    // Typed on the mock rather than on an arrow with unused parameters, so save.mock.calls[0][1]
    // is known to be the FormData the form submitted.
    const save = vi.fn<(state: GiftFormState, formData: FormData) => Promise<GiftFormState>>(async () => ({
      status: "invalid",
      recipientEmail: "invalidEmail",
      message: null,
    }));
    renderForm({ saveAction: save });

    await userEvent.type(screen.getByLabelText(copy.emailLabel), "friend@example.com");
    await userEvent.type(screen.getByLabelText(copy.messageLabel), "Enjoy");
    await userEvent.click(screen.getByRole("button", { name: copy.save }));

    expect(save).toHaveBeenCalledOnce();
    const formData = save.mock.calls[0][1];
    expect(formData.get("recipientEmail")).toBe("friend@example.com");
    expect(formData.get("message")).toBe("Enjoy");
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.invalidEmail);
  });

  it("submits the remove action for a configured gift", async () => {
    const remove = vi.fn(idle);
    renderForm({ gift: pendingGift, removeAction: remove });

    await userEvent.click(screen.getByRole("button", { name: copy.remove }));

    expect(remove).toHaveBeenCalledOnce();
  });
});
