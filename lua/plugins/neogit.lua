local M = {}

function M.setup()
  local neogit = require("neogit")

  neogit.setup({
    disable_signs = false,
    disable_hint = false,
    disable_context_highlighting = false,
    disable_commit_confirmation = false,
    -- Neogit refreshes its internal state after specific events, which can be expensive depending on the repository size.
    -- Disabling `auto_refresh` will make it so you have to manually refresh the status after you open it.
    auto_refresh = true,
    disable_builtin_notifications = false,
    use_magit_keybindings = false,
    -- Change the default way of opening neogit
    kind = "tab",
    -- The time after which an output console is shown for slow running commands
    console_timeout = 2000,
    -- Automatically show console if a command takes more than console_timeout milliseconds
    auto_show_console = true,
    status = {
      recent_commit_count = 10,
    },
    commit_editor = {
      kind = "split",
    },
    commit_select_view = {
      kind = "tab",
    },
    commit_view = {
      kind = "vsplit",
    },
    log_view = {
      kind = "tab",
    },
    rebase_editor = {
      kind = "split",
    },
    reflog_view = {
      kind = "tab",
    },
    merge_editor = {
      kind = "split",
    },
    preview_buffer = {
      kind = "split",
    },
    popup = {
      kind = "split",
    },
    -- customize displayed signs
    signs = {
      -- { CLOSED, OPENED }
      section = { "▸", "▾" },
      item = { "▸", "▾" },
      hunk = { "▸", "▾" },
    },
    integrations = {
      telescope = true,
      diffview = true,
    },
    sections = {
      -- Reverting/Cherry Picking
      sequencer = {
        folded = false,
        hidden = false,
      },
      untracked = {
        folded = false,
        hidden = false,
      },
      unstaged = {
        folded = false,
        hidden = false,
      },
      staged = {
        folded = false,
        hidden = false,
      },
      stashes = {
        folded = true,
        hidden = false,
      },
      unpulled_upstream = {
        folded = true,
        hidden = false,
      },
      unmerged_upstream = {
        folded = false,
        hidden = false,
      },
      unpulled_pushRemote = {
        folded = true,
        hidden = false,
      },
      unmerged_pushRemote = {
        folded = false,
        hidden = false,
      },
      recent = {
        folded = true,
        hidden = false,
      },
      rebase = {
        folded = true,
        hidden = false,
      },
    },
  })
end

return M

