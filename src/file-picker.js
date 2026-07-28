import { MultiSelectPrompt } from "@clack/core";
import chalk from "chalk";
import process from "node:process";

// ─── Windowed multi-select ───────────────────────────────────────────────────
// @clack/prompts' multiselect renders EVERY option in one frame — `maxItems`
// (the scrolling window) is implemented for `select` only. Its redraw then does
// `cursor.move(-999, -frameHeight)` with no clamp to the terminal height, so as
// soon as the option list is taller than the viewport the terminal scrolls, the
// cursor-up lands in the wrong place, and each redraw paints over the previous
// one. The list turns to garbage and you can no longer tell which row is
// highlighted or which boxes are ticked — i.e. you cannot pick your files.
//
// That is easy to hit: simple-git runs `git status -u`, so a single untracked
// folder (dist/, build/, coverage/) expands into every file inside it.
//
// Upgrading @clack/prompts to 1.x would fix it upstream, but 1.x requires
// Node >= 20.12 and pushprep supports Node >= 18, so the window is implemented
// here instead. The rendering deliberately mirrors clack's own multiselect so
// the prompt looks identical to every other prompt in the CLI.

// clack decides unicode vs ASCII the same way; mirrored so our frame matches the
// surrounding prompts on terminals that can't render box-drawing characters.
function unicodeSupported() {
  const env = process.env;
  return process.platform !== "win32"
    ? env.TERM !== "linux"
    : Boolean(env.CI) ||
        Boolean(env.WT_SESSION) ||
        Boolean(env.TERMINUS_SUBLIME) ||
        env.ConEmuTask === "{cmd::Cmder}" ||
        env.TERM_PROGRAM === "Terminus-Sublime" ||
        env.TERM_PROGRAM === "vscode" ||
        env.TERM === "xterm-256color" ||
        env.TERM === "alacritty" ||
        env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}

const UNICODE = unicodeSupported();
const sym = (fancy, plain) => (UNICODE ? fancy : plain);

const S_STEP_ACTIVE = sym("◆", "*");
const S_STEP_CANCEL = sym("■", "x");
const S_STEP_ERROR = sym("▲", "x");
const S_STEP_SUBMIT = sym("◇", "o");
const S_BAR = sym("│", "|");
const S_BAR_END = sym("└", "—");
const S_CHECKBOX_ACTIVE = sym("◻", "[•]");
const S_CHECKBOX_SELECTED = sym("◼", "[+]");
const S_CHECKBOX_INACTIVE = sym("◻", "[ ]");

function stateSymbol(state) {
  switch (state) {
    case "initial":
    case "active":
      return chalk.cyan(S_STEP_ACTIVE);
    case "cancel":
      return chalk.red(S_STEP_CANCEL);
    case "error":
      return chalk.yellow(S_STEP_ERROR);
    case "submit":
      return chalk.green(S_STEP_SUBMIT);
    default:
      return chalk.cyan(S_STEP_ACTIVE);
  }
}

// Rows the window may use. The frame also spends lines on the title, the bar
// ends and the error/hint, so we keep headroom below the terminal height —
// staying shorter than the viewport is exactly what stops the misaligned
// redraw. Read per render so a mid-prompt terminal resize is respected.
const RESERVED_ROWS = 6;
const MIN_WINDOW = 5;

export function visibleCount(total, rows = process.stdout.rows) {
  const height = Number.isFinite(rows) && rows > 0 ? rows : 24;
  // The MIN_WINDOW floor applies to the terminal height, not to the option
  // count — a 1-file list should render one row, not five.
  return Math.min(total, Math.max(MIN_WINDOW, height - RESERVED_ROWS));
}

/**
 * Computes the new scroll offset so the cursor stays inside the window, keeping
 * two rows of context above and below where possible. Mirrors the algorithm
 * clack uses for `select`'s maxItems window.
 *
 * @param {number} cursor - index of the highlighted option
 * @param {number} offset - current scroll offset
 * @param {number} win - number of rows the window shows
 * @param {number} total - total number of options
 * @returns {number} the clamped scroll offset
 */
export function scrollOffset(cursor, offset, win, total) {
  let next = offset;
  if (cursor >= next + win - 3) {
    next = Math.min(cursor - win + 3, total - win);
  } else if (cursor < next + 2) {
    next = cursor - 2;
  }
  return Math.max(0, Math.min(next, Math.max(0, total - win)));
}

/**
 * A multi-select prompt that scrolls instead of printing every option, so the
 * list stays usable no matter how many files changed.
 *
 * Same contract as `p.multiselect`: resolves to the array of chosen values, or
 * to clack's cancel symbol when the user aborts (pass it to `p.isCancel`).
 *
 * @param {{ message: string, options: {value: string, label?: string, hint?: string}[], initialValues?: string[], required?: boolean, cursorAt?: string }} opts
 * @returns {Promise<string[]|symbol>}
 */
export function multiselectScrolling(opts) {
  const total = opts.options.length;
  // Persisted across renders so the list doesn't jump back to the top.
  let offset = 0;

  const styleOption = (option, state) => {
    const label = option.label ?? String(option.value);
    const hint = option.hint ? chalk.dim(`(${option.hint})`) : "";
    switch (state) {
      case "active":
        return `${chalk.cyan(S_CHECKBOX_ACTIVE)} ${label} ${hint}`;
      case "selected":
        return `${chalk.green(S_CHECKBOX_SELECTED)} ${chalk.dim(label)}`;
      case "active-selected":
        return `${chalk.green(S_CHECKBOX_SELECTED)} ${label} ${hint}`;
      case "cancelled":
        return chalk.strikethrough(chalk.dim(label));
      case "submitted":
        return chalk.dim(label);
      default:
        return `${chalk.dim(S_CHECKBOX_INACTIVE)} ${chalk.dim(label)}`;
    }
  };

  // One option row, styled by whether it's ticked and/or under the cursor.
  const rowFor = function (option, index) {
    const selected = this.value.includes(option.value);
    const active = index === this.cursor;
    if (active && selected) return styleOption(option, "active-selected");
    if (selected) return styleOption(option, "selected");
    return styleOption(option, active ? "active" : "inactive");
  };

  // The visible slice, with the first/last row replaced by a "N more" marker
  // when the list continues off-window. Replacing rather than appending keeps
  // the frame height constant, which is what the redraw depends on.
  const windowRows = function () {
    const win = visibleCount(total);
    offset = scrollOffset(this.cursor, offset, win, total);
    const hiddenAbove = offset;
    const hiddenBelow = total - (offset + win);
    const rows = [];
    for (let i = offset; i < offset + win && i < total; i++) {
      const first = i === offset;
      const last = i === offset + win - 1;
      if (first && hiddenAbove > 0) {
        rows.push(chalk.dim(`↑ ${hiddenAbove} more`));
      } else if (last && hiddenBelow > 0) {
        rows.push(chalk.dim(`↓ ${hiddenBelow} more`));
      } else {
        rows.push(rowFor.call(this, this.options[i], i));
      }
    }
    return rows;
  };

  return new MultiSelectPrompt({
    options: opts.options,
    initialValues: opts.initialValues,
    required: opts.required ?? true,
    cursorAt: opts.cursorAt,
    validate(selected) {
      // `this` is the options object here (clack calls opts.validate), so the
      // `required` flag passed above is what's read.
      if (this.required && selected.length === 0) {
        return `Please select at least one file.\nPress ${chalk.inverse(" space ")} to select, ${chalk.inverse(" enter ")} to submit.`;
      }
    },
    render() {
      // Live count in the title: with a long list you can't see every tick, so
      // this is the only reliable read on how much is selected.
      const counter =
        this.state === "active" || this.state === "initial"
          ? chalk.dim(` (${this.value.length}/${total} selected)`)
          : "";
      const title = `${chalk.gray(S_BAR)}\n${stateSymbol(this.state)}  ${opts.message}${counter}\n`;

      switch (this.state) {
        case "submit": {
          const picked = this.options
            .filter((o) => this.value.includes(o.value))
            .map((o) => styleOption(o, "submitted"));
          // Long lists are summarised — echoing 200 paths defeats the purpose.
          const shown =
            picked.length > 8
              ? `${picked.slice(0, 8).join(chalk.dim(", "))}${chalk.dim(` … +${picked.length - 8} more`)}`
              : picked.join(chalk.dim(", "));
          return `${title}${chalk.gray(S_BAR)}  ${shown || chalk.dim("none")}`;
        }
        case "cancel": {
          const cancelled = this.options
            .filter((o) => this.value.includes(o.value))
            .map((o) => styleOption(o, "cancelled"))
            .join(chalk.dim(", "));
          return `${title}${chalk.gray(S_BAR)}  ${cancelled.trim() ? `${cancelled}\n${chalk.gray(S_BAR)}` : ""}`;
        }
        case "error": {
          const message = this.error
            .split("\n")
            .map((line, i) =>
              i === 0
                ? `${chalk.yellow(S_BAR_END)}  ${chalk.yellow(line)}`
                : `   ${line}`,
            )
            .join("\n");
          return `${title}${chalk.yellow(S_BAR)}  ${windowRows
            .call(this)
            .join(`\n${chalk.yellow(S_BAR)}  `)}\n${message}\n`;
        }
        default:
          return `${title}${chalk.cyan(S_BAR)}  ${windowRows
            .call(this)
            .join(`\n${chalk.cyan(S_BAR)}  `)}\n${chalk.cyan(S_BAR_END)}\n`;
      }
    },
  }).prompt();
}
