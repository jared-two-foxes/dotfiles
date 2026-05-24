return {
  -- ─── Inline git indicators in the gutter ─────────────────────────────────────
  {
    "lewis6991/gitsigns.nvim",
    event = { "BufReadPre", "BufNewFile" },
    opts  = {
      signs = {
        add          = { text = "▎" },
        change       = { text = "▎" },
        delete       = { text = "" },
        topdelete    = { text = "" },
        changedelete = { text = "▎" },
        untracked    = { text = "▎" },
      },
      signs_staged_enable = true,
      current_line_blame  = false,
      on_attach = function(buffer)
        local gs = package.loaded.gitsigns

        local function map(mode, lhs, rhs, desc)
          vim.keymap.set(mode, lhs, rhs, { buffer = buffer, desc = desc })
        end

        -- Navigate hunks
        map("n", "]c", function()
          if vim.wo.diff then vim.cmd.normal({ "]c", bang = true })
          else gs.nav_hunk("next") end
        end, "Next hunk")
        map("n", "[c", function()
          if vim.wo.diff then vim.cmd.normal({ "[c", bang = true })
          else gs.nav_hunk("prev") end
        end, "Prev hunk")

        -- Hunk actions
        map({ "n", "v" }, "<leader>gs", "<cmd>Gitsigns stage_hunk<cr>",       "Stage hunk")
        map({ "n", "v" }, "<leader>gr", "<cmd>Gitsigns reset_hunk<cr>",       "Reset hunk")
        map("n",          "<leader>gS", gs.stage_buffer,                       "Stage buffer")
        map("n",          "<leader>gu", gs.undo_stage_hunk,                    "Undo stage hunk")
        map("n",          "<leader>gR", gs.reset_buffer,                       "Reset buffer")
        map("n",          "<leader>gp", gs.preview_hunk_inline,                "Preview hunk inline")
        map("n",          "<leader>gb", function() gs.blame_line({ full = true }) end, "Blame line")
        map("n",          "<leader>gB", gs.toggle_current_line_blame,          "Toggle line blame")

        -- Text object: select hunk
        map({ "o", "x" }, "ih", "<cmd>Gitsigns select_hunk<cr>", "Select hunk")
      end,
    },
  },

  -- ─── Unified diff / Git commands (fugitive) ──────────────────────────────────
  {
    "tpope/vim-fugitive",
    cmd  = { "Git", "Gdiffsplit", "Gread", "Gwrite", "Ggrep", "GMove", "GDelete", "GBrowse" },
    keys = {
      { "<leader>gg", "<cmd>Git<cr>",      desc = "Git status (fugitive)" },
      { "<leader>gf", "<cmd>Git diff<cr>", desc = "Unified diff (fugitive)" },
    },
  },

  -- ─── Full diff and history viewer ────────────────────────────────────────────
  {
    "sindrets/diffview.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    cmd  = { "DiffviewOpen", "DiffviewClose", "DiffviewToggleFiles", "DiffviewFocusFiles", "DiffviewFileHistory" },
    keys = {
      { "<leader>gd", "<cmd>DiffviewOpen<cr>",            desc = "Open diffview (working tree)" },
      { "<leader>gD", "<cmd>DiffviewClose<cr>",           desc = "Close diffview" },
      { "<leader>gh", "<cmd>DiffviewFileHistory %<cr>",   desc = "File history (current file)" },
      { "<leader>gH", "<cmd>DiffviewFileHistory<cr>",     desc = "Repo history" },
    },
    opts = {
      enhanced_diff_hl = true,
      view = {
        default = {
          layout = "diff2_horizontal",
        },
        merge_tool = {
          layout     = "diff3_horizontal",
          disable_diagnostics = true,
        },
        file_history = {
          layout = "diff2_horizontal",
        },
      },
      file_panel = {
        listing_style   = "tree",
        tree_options    = {
          flatten_dirs  = true,
          folder_statuses = "only_folded",
        },
        win_config = {
          position = "left",
          width    = 35,
        },
      },
      hooks = {
        -- Close neo-tree when diffview opens so they don't fight for space
        view_opened = function()
          require("neo-tree.command").execute({ action = "close" })
        end,
      },
    },
  },
}
