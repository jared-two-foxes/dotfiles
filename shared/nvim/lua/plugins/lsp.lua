return {
  -- ─── Syntax highlighting & indentation ───────────────────────────────────────
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    event = { "BufReadPost", "BufNewFile" },
    opts  = {
      ensure_installed = {
        "c", "cpp",
        "rust",
        "python",
        "typescript", "tsx", "javascript",
        "markdown", "markdown_inline",
        "lua", "vim", "vimdoc",
        "bash",
        "json", "jsonc",
        "toml",
        "yaml",
        "diff",   -- for diffview syntax
        "regex",
      },
      highlight = {
        enable  = true,
        -- Disable for very large files
        disable = function(_, buf)
          local max_filesize = 500 * 1024 -- 500 KB
          local ok, stats = pcall(vim.loop.fs_stat, vim.api.nvim_buf_get_name(buf))
          if ok and stats and stats.size > max_filesize then return true end
        end,
      },
      indent = { enable = true },
    },
    config = function(_, opts)
      -- On Windows there is no system C compiler; zig ships its own libc and
      -- acts as a drop-in cc, so point treesitter at it explicitly.
      require("nvim-treesitter.install").compilers = { "zig", "cl", "gcc", "cc" }
      require("nvim-treesitter.configs").setup(opts)
    end,
  },

  -- ─── Mason: LSP / linter / formatter installer ───────────────────────────────
  {
    "williamboman/mason.nvim",
    build = ":MasonUpdate",
    cmd   = { "Mason", "MasonInstall", "MasonUpdate" },
    keys  = {
      { "<leader>lm", "<cmd>Mason<cr>", desc = "Open Mason" },
    },
    config = function()
      require("mason").setup({
        ui = {
          border = "rounded",
          icons  = { package_installed = "✓", package_pending = "➜", package_uninstalled = "✗" },
        },
      })

      -- Auto-install servers defined in mason-lspconfig
      local registry = require("mason-registry")
      local tools    = {
        "clangd",
        "rust-analyzer",
        "pyright",
        "typescript-language-server",
        "marksman",
      }

      local function install_missing()
        for _, name in ipairs(tools) do
          local ok, pkg = pcall(registry.get_package, name)
          if ok and not pkg:is_installed() then
            pkg:install()
          end
        end
      end

      if registry.refresh then
        registry.refresh(install_missing)
      else
        install_missing()
      end
    end,
  },

  -- ─── mason-lspconfig bridge ───────────────────────────────────────────────────
  {
    "williamboman/mason-lspconfig.nvim",
    lazy = true,
    dependencies = { "williamboman/mason.nvim" },
    opts = {},
  },

  -- ─── LSP client configuration ─────────────────────────────────────────────────
  {
    "neovim/nvim-lspconfig",
    event        = { "BufReadPre", "BufNewFile" },
    dependencies = {
      "williamboman/mason.nvim",
      "williamboman/mason-lspconfig.nvim",
      "hrsh7th/cmp-nvim-lsp", -- exposes capabilities to servers
    },
    config = function()
      -- Rounded borders for hover/signature windows
      local orig_util_open_floating_preview = vim.lsp.util.open_floating_preview
      function vim.lsp.util.open_floating_preview(contents, syntax, opts, ...)
        opts = opts or {}
        opts.border = opts.border or "rounded"
        return orig_util_open_floating_preview(contents, syntax, opts, ...)
      end

      -- Diagnostic display configuration
      vim.diagnostic.config({
        virtual_text     = { prefix = "●", source = "if_many" },
        signs            = true,
        underline        = true,
        update_in_insert = false,
        severity_sort    = true,
        float            = { border = "rounded", source = "if_many" },
      })

      -- Diagnostic signs in the gutter
      local signs = { Error = " ", Warn = " ", Hint = "󰠠 ", Info = " " }
      for type, icon in pairs(signs) do
        local hl = "DiagnosticSign" .. type
        vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = "" })
      end

      -- Attach keymaps when an LSP server connects
      vim.api.nvim_create_autocmd("LspAttach", {
        group    = vim.api.nvim_create_augroup("UserLspKeymaps", { clear = true }),
        callback = function(event)
          local buf = event.buf
          local function map(lhs, rhs, desc)
            vim.keymap.set("n", lhs, rhs, { buffer = buf, desc = "LSP: " .. desc })
          end

          map("gd",         vim.lsp.buf.definition,      "Go to definition")
          map("gD",         vim.lsp.buf.declaration,     "Go to declaration")
          map("gr",         vim.lsp.buf.references,      "Go to references")
          map("gi",         vim.lsp.buf.implementation,  "Go to implementation")
          map("gt",         vim.lsp.buf.type_definition, "Go to type definition")
          map("K",          vim.lsp.buf.hover,           "Hover documentation")
          map("<C-k>",      vim.lsp.buf.signature_help,  "Signature help")
          map("<leader>rn", vim.lsp.buf.rename,          "Rename symbol")
          map("<leader>ca", vim.lsp.buf.code_action,     "Code action")
          map("<leader>ld", vim.diagnostic.open_float,   "Line diagnostics")
          map("<leader>ll", vim.lsp.codelens.run,        "Run codelens")
          map("[d",         vim.diagnostic.goto_prev,    "Prev diagnostic")
          map("]d",         vim.diagnostic.goto_next,    "Next diagnostic")
        end,
      })

      -- Enhanced capabilities (includes snippet support for nvim-cmp)
      local capabilities = require("cmp_nvim_lsp").default_capabilities()

      -- Server-specific config overrides (defaults come from nvim-lspconfig's lsp/ dir)
      local servers = {
        clangd = {
          capabilities = vim.tbl_deep_extend("force", capabilities, {
            offsetEncoding = { "utf-16" },
          }),
          cmd = { "clangd", "--background-index", "--clang-tidy", "--header-insertion=iwyu" },
        },
        rust_analyzer = {
          capabilities = capabilities,
          settings = {
            ["rust-analyzer"] = {
              checkOnSave = { command = "clippy" },
            },
          },
        },
        pyright      = { capabilities = capabilities },
        ts_ls        = { capabilities = capabilities },
        marksman     = { capabilities = capabilities },
      }

      for name, config in pairs(servers) do
        vim.lsp.config(name, config)
      end
      vim.lsp.enable(vim.tbl_keys(servers))
    end,
  },
}
