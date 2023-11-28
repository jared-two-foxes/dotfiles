local set = vim.opt

local M = {}

local function has_words_before()
  local line, col = table.unpack(vim.api.nvim_win_get_cursor(0))
  return col ~= 0 and vim.api.nvim_buf_get_lines(0, line - 1, line, true)[1]:sub(col, col):match("%s") == nil
end

function M.setup()
  set.completeopt = { "menu", "menuone", "noselect" }

  local cmp = require("cmp")
  local luasnip = require("luasnip")
  local lspkind = require("lspkind")

  local select_opts = { behavior = cmp.SelectBehavior.Select }

  cmp.setup({
    snippet = {
      expand = function(args)
        luasnip.lsp_expand(args.body)
      end,
    },
    sources = cmp.config.sources({
      { name = "nvim_lsp", keyword_length = 0, group_index = 2 },
      { name = "path", keyword_length = 0, group_index = 3 },
      { name = "buffer", keyword_length = 0, group_index = 4 },
      { name = "nvim_lsp_signature_help", keyword_length = 2 },
      { name = "dap", keyword_length = 0 },
    }, {}),
    sorting = {
      comparators = {
        require("clangd_extensions.cmp_scores"),
        cmp.config.compare.offset,
        cmp.config.compare.exact,
        cmp.config.compare.score,
        cmp.config.compare.recently_used,
        cmp.config.compare.locality,
        cmp.config.compare.kind,
        cmp.config.compare.sort_text,
        cmp.config.compare.length,
        cmp.config.compare.order,
      },
    },
    window = {
      completion = cmp.config.window.bordered(),
      documentation = cmp.config.window.bordered(),
    },
    formatting = {
      format = lspkind.cmp_format({
        mode = "symbol_text",
        symbol_map = { Copilot = "" },
        max_width = 100,
        menu = {
          buffer = "[Buffer]",
          nvim_lsp = "[LSP]",
          luasnip = "[LuaSnip]",
          nvim_lua = "[Lua]",
        },
      }),
    },
    mapping = {
      ["<C-Space>"] = cmp.mapping({ i = cmp.mapping.complete({ reason = cmp.ContextReason.Manual }) }),
      ["<Tab>"] = cmp.mapping(function(fallback)
        if cmp.visible() then
          cmp.select_next_item(select_opts)
        elseif luasnip.expand_or_jumpable() then
          luasnip.expand_or_jump()
        elseif has_words_before() then
          cmp.complete()
        else
          fallback()
        end
      end, { "i", "s" }),
      ["<S-Tab>"] = cmp.mapping(function(fallback)
        if cmp.visible() then
          cmp.select_prev_item(select_opts)
        elseif luasnip.jumpable(-1) then
          luasnip.jump(-1)
        else
          fallback()
        end
      end, { "i", "s" }),
      ["<C-r>"] = cmp.mapping.confirm({ select = true, behavior = cmp.ConfirmBehavior.Replace }), -- For some reason this mapping seems to mess with the <Tab> mapping ?!
      ["<C-i>"] = cmp.mapping.confirm({ select = true, behavior = cmp.ConfirmBehavior.Insert }),
      ["<cr>"] = cmp.mapping.confirm({ select = false, behavior = cmp.ConfirmBehavior.Insert }),

      -- ["<C-b>"] = cmp.mapping.scroll_docs(-4),
      -- ["<C-f>"] = cmp.mapping.scroll_docs(4),
      --
      ["<C-e>"] = cmp.mapping.abort(),
    },
  })

  -- Use buffer source for `/` and `?` (if you enabled `native_menu`, this won't work anymore).
  cmp.setup.cmdline({ "/", "?" }, {
    mapping = cmp.mapping.preset.cmdline(),
    sources = {
      { name = "buffer" },
    },
  })

  -- Use cmdline & path source for ':' (if you enabled `native_menu`, this won't work anymore).
  cmp.setup.cmdline(":", {
    mapping = cmp.mapping.preset.cmdline(),
    sources = cmp.config.sources({
      { name = "path" },
    }, {
      { name = "cmdline" },
    }),
  })
end

return M

