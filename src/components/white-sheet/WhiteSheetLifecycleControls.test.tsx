import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WhiteSheetLifecycleControls } from "./WhiteSheetLifecycleControls";

describe("WhiteSheetLifecycleControls", () => {
  it("shows Finalize for a submitted (matched) entry", () => {
    const html = renderToStaticMarkup(
      <WhiteSheetLifecycleControls
        entryStatus="submitted"
        onFinalize={async () => {}}
        onReopen={async () => {}}
      />,
    );
    expect(html).toContain("white-sheet-finalize-button");
    expect(html).toContain("Finalize / ยืนยันปิดยอด");
    expect(html).toContain("รอผู้ดูแลระบบยืนยันปิดยอด");
    expect(html).not.toContain("white-sheet-reopen-button");
  });

  it("shows Reopen + finalized actor/time for a finalized entry", () => {
    const html = renderToStaticMarkup(
      <WhiteSheetLifecycleControls
        entryStatus="finalized"
        finalizedAt="2026-07-25T06:00:00.000Z"
        finalizedBy="admin-actor-1"
        onFinalize={async () => {}}
        onReopen={async () => {}}
      />,
    );
    expect(html).toContain("white-sheet-reopen-button");
    expect(html).toContain("Reopen / เปิดยอดอีกครั้ง");
    expect(html).toContain("white-sheet-reopen-reason");
    expect(html).toContain("admin-actor-1");
    expect(html).toContain("ยืนยันปิดยอดแล้ว");
    expect(html).not.toContain("white-sheet-finalize-button");
  });

  it("does not expose finalize/reopen controls before submission", () => {
    const html = renderToStaticMarkup(
      <WhiteSheetLifecycleControls
        entryStatus="not_submitted"
        onFinalize={async () => {}}
        onReopen={async () => {}}
      />,
    );
    expect(html).toContain("ยังไม่ได้บันทึกค่าใช้จ่าย");
    expect(html).not.toContain("white-sheet-finalize-button");
    expect(html).not.toContain("white-sheet-reopen-button");
  });

  it("disables lifecycle controls while a request is pending", () => {
    const submitted = renderToStaticMarkup(
      <WhiteSheetLifecycleControls
        entryStatus="submitted"
        isPending
        onFinalize={async () => {}}
        onReopen={async () => {}}
      />,
    );
    expect(submitted).toContain("disabled");

    const finalized = renderToStaticMarkup(
      <WhiteSheetLifecycleControls
        entryStatus="finalized"
        isPending
        finalizedAt="2026-07-25T06:00:00.000Z"
        finalizedBy="admin-actor-1"
        onFinalize={async () => {}}
        onReopen={async () => {}}
      />,
    );
    expect(finalized).toContain("disabled");
  });

  it("renders lifecycle API errors without implying success", () => {
    const html = renderToStaticMarkup(
      <WhiteSheetLifecycleControls
        entryStatus="submitted"
        error="entry is already finalized"
        onFinalize={async () => {}}
        onReopen={async () => {}}
      />,
    );
    expect(html).toContain("white-sheet-lifecycle-error");
    expect(html).toContain("entry is already finalized");
    expect(html).toContain("white-sheet-finalize-button");
  });
});
