return {
  -- ─── File explorer ────────────────────────────────────────────────────────────
  {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-tree/nvim-web-devicons",
      "MunifTanjim/nui.nvim",
    },
    cmd  = "Neotree",
    keys = {
      { "<leader>e", "<cmd>Neotree toggle<cr>", desc = "Toggle file explorer" },
      { "<leader>o", "<cmd>Neotree focus<cr>",  desc = "Focus file explorer" },
    },
    opts = {
      close_if_last_window = true,
      popup_border_style   = "rounded",
      enable_git_status    = true,
      enable_diagnostics   = true,
      window = {
        position = "left",
        width    = 35,
        mappings = {
          ["<space>"] = "none", -- don't let neo-tree steal <space>
          ["<cr>"]    = "open",
          ["l"]       = "open",
          ["h"]       = "close_node",
          ["P"]       = { "toggle_preview", config = { use_float = true } },
        },
      },
      filesystem = {
        filtered_items = {
          visible         = false,
          hide_dotfiles   = false,
          hide_gitignored = false,
        },
        follow_current_file = {
          enabled         = true,
          leave_dirs_open = false,
        },
        use_libuv_file_watcher = true,
      },
      default_component_configs = {
        git_status = {
          symbols = {
            added     = "✚",
            modified  = "",
            deleted   = "✖",
            renamed   = "󰁕",
            untracked = "",
            ignored   = "",
            unstaged  = "󰄱",
            staged    = "",
            conflict  = "",
          },
        },
      },
    },
  },

  -- ─── Fuzzy finder + utility suite ────────────────────────────────────────────
  {
    "folke/snacks.nvim",
    priority = 1000, -- load early so notifier is available immediately
    lazy     = false,
    ---@type snacks.Config
    opts = {
      -- ── Modules to enable ──────────────────────────────────────────────
      picker    = {},  -- replaces telescope
      notifier  = {},  -- replaces vim.notify
      quickfile = {},  -- faster startup when opening a file directly
      indent    = {},  -- indent scope guides

      -- ── Modules explicitly disabled ────────────────────────────────────
      -- lazygit: known Windows IPC deadlock — keep off
      lazygit   = { enabled = false },
      -- dashboard: handled by colorscheme/startup elsewhere if needed
      dashboard = { enabled = false },
      -- bigfile: not needed for this config
      bigfile   = { enabled = false },
      -- statuscolumn, words, scroll, animate: personal preference — off by default
      statuscolumn = { enabled = false },
      words        = { enabled = false },
      scroll       = { enabled = false },
      animate      = { enabled = false },
    },
    keys = {
      -- ── Find (picker) ─────────────────────────────────────────────────
      { "<leader>ff", function() Snacks.picker.files() end,        desc = "Find files" },
      { "<leader>fg", function() Snacks.picker.grep() end,         desc = "Live grep" },
      { "<leader>fb", function() Snacks.picker.buffers() end,      desc = "Find buffers" },
      { "<leader>fr", function() Snacks.picker.recent() end,       desc = "Recent files" },
      { "<leader>fh", function() Snacks.picker.help() end,         desc = "Help tags" },
      { "<leader>fs", function() Snacks.picker.grep_word() end,    desc = "Grep word under cursor",
        mode = { "n", "v" } },
      { "<leader>fc", function() Snacks.picker.commands() end,     desc = "Commands" },
      { "<leader>fd", function() Snacks.picker.diagnostics() end,  desc = "Diagnostics" },
      { "<leader>fk", function() Snacks.picker.keymaps() end,      desc = "Keymaps" },
      { "<leader>fn", function() Snacks.notifier.show_history() end, desc = "Notifications" },
      { "<leader>/",  function() Snacks.picker.lines() end,        desc = "Fuzzy find in buffer" },

      -- ── Git pickers (complement diffview + gitsigns) ──────────────────
      { "<leader>gl", function() Snacks.picker.git_log() end,       desc = "Git log" },
      { "<leader>gL", function() Snacks.picker.git_log_file() end,  desc = "Git log (current file)" },
    },
  },

  -- ─── Key binding hints ────────────────────────────────────────────────────────
  {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts  = {
      delay = 500,
      icons = { rules = false }, -- use plain text labels
    },
    config = function(_, opts)
      local wk = require("which-key")
      wk.setup(opts)
      wk.add({
        { "<leader>f", group = "find" },
        { "<leader>g", group = "git" },
        { "<leader>l", group = "lsp" },
        { "<leader>b", group = "buffer" },
      })
    end,
  },
}
