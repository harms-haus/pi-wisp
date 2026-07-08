import { vi } from "vitest";

// Mock the Text and Container classes from pi-tui so tests can run without the TUI dependency
vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(public content: string) {}
    render = vi.fn(() => this.content);
  },
  Container: class Container {
    render = vi.fn(() => "");
  },
}));
