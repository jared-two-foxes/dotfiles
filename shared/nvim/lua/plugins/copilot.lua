-- GitHub Copilot via copilot-cmp (suggestions appear in the nvim-cmp popup,
-- cycled with Tab just like any other completion source).
-- Native ghost-text is disabled to avoid a duplicate UI.
--
-- First-time setup: run `:Copilot auth` to authenticate.

return {
  -- Core Copilot engine
  {
    "zbirenbaum/copilot.lua",
    cmd   = "Copilot",
    event = "InsertEnter",
    opts  = {
      -- Disable native ghost-text; completions flow through nvim-cmp instead
      suggestion = { enabled = false },
      panel      = { enabled = false },
      filetypes  = {
        -- Enable broadly; disable in help and plain-text buffers
        ["*"]    = true,
        help     = false,
        gitcommit = false,
        gitrebase = false,
      },
    },
  },

  -- Copilot source for nvim-cmp
  {
    "zbirenbaum/copilot-cmp",
    event        = "InsertEnter",
    dependencies = { "zbirenbaum/copilot.lua" },
    config       = true,
  },
}
