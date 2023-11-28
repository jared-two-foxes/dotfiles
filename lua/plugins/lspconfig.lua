local M = {}

local navic = require("nvim-navic")

local function on_attach(client, bufnr)
  navic.attach(client, bufnr)
end

function M.setup()
  local lspconfig = require("lspconfig")
  local capabilities = require("cmp_nvim_lsp").default_capabilities()
  local mason_registry = require("mason-registry")

  -- Clangd
  local clangd_executable = vim.fn.glob(mason_registry.get_package("clangd"):get_install_path() .. "/clangd_*")
    .. "/bin/clangd"

  lspconfig.clangd.setup({
    filetypes = { "c", "cpp", "cc", "mpp", "ixx", "objc", "objcpp", "cuda" },
    cmd = {
      clangd_executable,
      "--query-driver=/**/*",
      "--clang-tidy",
      "--header-insertion=never",
      "--offset-encoding=utf-16",
    },
    capabilities = capabilities,
    on_attach = function(client, bufnr)
      navic.attach(client, bufnr)
      require("clangd_extensions.inlay_hints").setup_autocmd()
      require("clangd_extensions.inlay_hints").set_inlay_hints()
    end,
  })

  -- Lua
  lspconfig.lua_ls.setup({
    capabilities = capabilities,
    on_attach = on_attach,
    settings = {
      Lua = {
        diagnostics = {
          globals = { "vim", "use" },
        },
      },
    },
  })

  lspconfig.cmake.setup({ capabilities = capabilities })
  lspconfig.pylsp.setup({
    capabilities = capabilities,
    on_attach = on_attach,
    settings = {
      pylsp = {
        plugins = {
          autopep8 = { enabled = false },
          flake8 = { enabled = true },
          yapf = { enabled = true },
          pylint = { enabled = true },
          pydocstyle = { enabled = true },
        },
      },
    },
  })
end

return M


