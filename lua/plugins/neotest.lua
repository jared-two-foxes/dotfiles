local M = {}

function M.setup()
  require("neotest-gtest").setup({})
  require("neotest").setup({
    adapters = {
      require("neotest-gtest"),
      require("neotest-python")({
        dap = { justMyCode = false },
      }),
      require("neotest-rust"),
    },
  })
end

return M

