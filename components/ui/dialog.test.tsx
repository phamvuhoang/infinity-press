import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

afterEach(cleanup);

function Example() {
  return (
    <Dialog>
      <DialogTrigger>Open</DialogTrigger>
      <DialogPanel side="right">
        <DialogTitle>Settings</DialogTitle>
        <button type="button">Inside</button>
        <DialogClose>Close</DialogClose>
      </DialogPanel>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("opens from its trigger and names itself", async () => {
    const user = userEvent.setup();
    render(<Example />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  // The whole reason a primitive exists rather than two hand-rolled panels: Escape, focus return
  // and the ARIA wiring are implemented once.
  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Example />);

    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes from its close button", async () => {
    const user = userEvent.setup();
    render(<Example />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses the inherited dark foreground for DialogClose hover while preserving dialog dismissal", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open reader settings</DialogTrigger>
        <DialogPanel className="bg-ink text-ivory">
          <DialogTitle>Reading settings</DialogTitle>
          <DialogClose>Close</DialogClose>
        </DialogPanel>
      </Dialog>,
    );

    await user.click(screen.getByRole("button", { name: "Open reader settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Reading settings" });
    const close = screen.getByRole("button", { name: "Close" });

    // A fixed foreground token would make this ivory-on-ink control's hover disappear.
    expect(close).toHaveClass("hover:bg-current/10");
    await user.click(close);
    expect(screen.queryByRole("dialog", { name: "Reading settings" })).toBeNull();
    expect(dialog).not.toBeInTheDocument();
  });
});
