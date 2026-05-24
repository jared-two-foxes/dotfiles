return {
  -- ─── Icons (shared dependency) ───────────────────────────────────────────────
  { "nvim-tree/nvim-web-devicons", lazy = true },

  -- ─── Catppuccin theme ─────────────────────────────────────────────────────────
  {
    "catppuccin/nvim",
    name = "catppuccin",
    priority = 1000, -- load before everything else
    opts = {
      flavour = "mocha",
      transparent_background = false,
      show_end_of_buffer = false,
      term_colors = true,
      dim_inactive = {
        enabled = false,
      },
      styles = {
        comments = { "italic" },
        keywords = { "italic" },
        functions = {},
        variables = {},
      },
      integrations = {
        cmp            = true,
        gitsigns       = true,
        neo_tree       = true,
        snacks         = true,
        treesitter     = true,
        which_key      = true,
        mason          = true,
        diffview       = true,
        native_lsp     = {
          enabled = true,
          virtual_text = {
            errors      = { "italic" },
            hints       = { "italic" },
            warnings    = { "italic" },
            information = { "italic" },
          },
          underlines = {
            errors      = { "underline" },
            hints       = { "underline" },
            warnings    = { "underline" },
            information = { "underline" },
          },
        },
      },
      custom_highlights = function(colors)
        return {
          -- Classic Vim diff groups (fugitive :Git diff, :Gdiffsplit, vimdiff)
          DiffAdd    = { fg = colors.green,  bg = "#1e3028" },
          DiffDelete = { fg = colors.red,    bg = "#2e1e28" },
          DiffChange = { fg = colors.yellow, bg = "#2a2918" },
          DiffText   = { fg = colors.yellow, bg = "#3d3a1a", bold = true },
          -- Treesitter diff groups (active when the diff parser attaches)
          ["@diff.plus"]  = { fg = colors.green,  bg = "#1e3028" },
          ["@diff.minus"] = { fg = colors.red,    bg = "#2e1e28" },
          ["@diff.delta"] = { fg = colors.yellow, bg = "#2a2918" },
        }
      end,
    },
    config = function(_, opts)
      require("catppuccin").setup(opts)
      vim.cmd.colorscheme("catppuccin")
    end,
  },

  -- ─── Statusline ───────────────────────────────────────────────────────────────
  {
    "nvim-lualine/lualine.nvim",
    event        = "VeryLazy",
    dependencies = { "nvim-tree/nvim-web-devicons", "catppuccin/nvim" },
    config = function()
      -- catppuccin ships its lualine theme as "catppuccin-nvim" (auto-detects
      -- configured flavour) — there is no "catppuccin" theme file.
      local theme = require("lualine.themes.catppuccin-nvim")

      require("lualine").setup({
        options = {
          theme                = theme,
          globalstatus         = true,
          component_separators = { left = "│", right = "│" },
          section_separators   = { left = "", right = "" },
          disabled_filetypes   = { statusline = { "neo-tree", "lazy", "mason" } },
        },
        sections = {
          lualine_a = { "mode" },
          lualine_b = { "branch", "diff", "diagnostics" },
          lualine_c = { { "filename", path = 1, symbols = { modified = " ●", readonly = " ", unnamed = "[No Name]" } } },
          lualine_x = { "encoding", "fileformat", "filetype" },
          lualine_y = { "progress" },
          lualine_z = { "location" },
        },
      })
    end,
  },
}
