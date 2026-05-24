return {
  -- ─── Snippet engine ───────────────────────────────────────────────────────────
  {
    "L3MON4D3/LuaSnip",
    lazy = true,
    -- jsregexp is optional; skip the build on Windows where `make` may be absent
    build = vim.fn.has("win32") == 0 and "make install_jsregexp" or nil,
  },

  -- ─── Completion sources ───────────────────────────────────────────────────────
  { "hrsh7th/cmp-nvim-lsp", lazy = true },
  { "hrsh7th/cmp-buffer",   lazy = true },
  { "hrsh7th/cmp-path",     lazy = true },
  { "saadparwaiz1/cmp_luasnip", lazy = true },

  -- ─── Completion engine ────────────────────────────────────────────────────────
  {
    "hrsh7th/nvim-cmp",
    event = "InsertEnter",
    dependencies = {
      "L3MON4D3/LuaSnip",
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-buffer",
      "hrsh7th/cmp-path",
      "saadparwaiz1/cmp_luasnip",
      -- copilot-cmp is declared in copilot.lua but we reference the source here
      { "zbirenbaum/copilot-cmp", optional = true },
    },
    config = function()
      local cmp     = require("cmp")
      local luasnip = require("luasnip")

      cmp.setup({
        snippet = {
          expand = function(args)
            luasnip.lsp_expand(args.body)
          end,
        },

        mapping = cmp.mapping.preset.insert({
          -- Tab: cycle forward through the menu, or expand/jump snippet
          ["<Tab>"] = cmp.mapping(function(fallback)
            if cmp.visible() then
              cmp.select_next_item({ behavior = cmp.SelectBehavior.Insert })
            elseif luasnip.expand_or_locally_jumpable() then
              luasnip.expand_or_jump()
            else
              fallback()
            end
          end, { "i", "s" }),

          -- Shift-Tab: cycle backward / jump snippet backward
          ["<S-Tab>"] = cmp.mapping(function(fallback)
            if cmp.visible() then
              cmp.select_prev_item({ behavior = cmp.SelectBehavior.Insert })
            elseif luasnip.locally_jumpable(-1) then
              luasnip.jump(-1)
            else
              fallback()
            end
          end, { "i", "s" }),

          -- Explicit triggers / controls
          ["<C-Space>"] = cmp.mapping.complete(),
          ["<C-e>"]     = cmp.mapping.abort(),
          ["<C-u>"]     = cmp.mapping.scroll_docs(-4),
          ["<C-d>"]     = cmp.mapping.scroll_docs(4),

          -- Enter confirms the explicitly selected item (not auto-selected)
          ["<CR>"] = cmp.mapping.confirm({ select = false }),
        }),

        sources = cmp.config.sources({
          { name = "copilot",  priority = 100, group_index = 1 },
          { name = "nvim_lsp", priority = 90,  group_index = 1 },
          { name = "luasnip",  priority = 80,  group_index = 1 },
          { name = "buffer",   priority = 50,  group_index = 2, keyword_length = 3 },
          { name = "path",     priority = 40,  group_index = 2 },
        }),

        formatting = {
          fields = { "kind", "abbr", "menu" },
          format = function(entry, item)
            local kind_icons = {
              Text          = "󰉿", Method        = "󰆧", Function     = "󰊕",
              Constructor   = "",  Field         = "󰜢", Variable     = "󰀫",
              Class         = "󰠱", Interface     = "", Module       = "",
              Property      = "󰜢", Unit          = "󰑭", Value        = "󰎠",
              Enum          = "", Keyword       = "󰌋", Snippet      = "",
              Color         = "󰏘", File          = "󰈙", Reference    = "󰈇",
              Folder        = "󰉋", EnumMember    = "", Constant     = "󰏿",
              Struct        = "󰙅", Event         = "", Operator     = "󰆕",
              TypeParameter = "󰊄", Copilot       = "",
            }
            local source_labels = {
              nvim_lsp = "[LSP]",
              luasnip  = "[Snip]",
              buffer   = "[Buf]",
              path     = "[Path]",
              copilot  = "[AI]",
            }
            item.kind = string.format("%s %s", kind_icons[item.kind] or "?", item.kind)
            item.menu = source_labels[entry.source.name] or ""
            return item
          end,
        },

        window = {
          completion    = cmp.config.window.bordered({ winhighlight = "Normal:Normal,FloatBorder:FloatBorder" }),
          documentation = cmp.config.window.bordered({ winhighlight = "Normal:Normal,FloatBorder:FloatBorder" }),
        },

        experimental = {
          ghost_text = false, -- copilot handles its own suggestions
        },
      })
    end,
  },
}
