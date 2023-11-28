local M = {}

function M.setup()
  require("lsp_lines").setup()

  vim.diagnostic.config({
    virtual_text = false,
  })
end

return M

