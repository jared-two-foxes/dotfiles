local M = {}

local media_extensions = { "png", "jpg", "jpeg", "bmp", "gif", "tiff", "webp", "pdf", "mp4", "webm", "mov", "mkv" }

local function _open_with_eog(filepath)
  os.execute("eog " .. filepath .. " &")
end

local function _open_with_chafa(filepath)
  os.execute("chafa " .. filepath .. " &")
end

local function is_media(filepath)
  if not filepath.lower then
    return false
  end
  local split_path = vim.split(filepath:lower(), ".", { plain = true })
  local extension = split_path[#split_path]
  return vim.tbl_contains(media_extensions, extension)
end

function M.setup()
  local actions = require("telescope.actions")
  local state = require("telescope.actions.state")

  require("telescope").setup({
    defaults = {
      -- Default configuration for telescope goes here:
      -- config_key = value,
      mappings = {
        i = {
          -- map actions.which_key to <C-h> (default: <C-/>)
          -- actions.which_key shows the mappings for your picker,
          -- e.g. git_{create, delete, ...}_branch for the git_branches picker
          ["<C-h>"] = "which_key",
          ["<CR>"] = function(prompt_bufnr)
            local entry = state.get_selected_entry()
            local filepath = entry and entry.value or nil
            if filepath and is_media(filepath) then
              actions.close(prompt_bufnr)
              _open_with_eog(filepath)
            else
              actions.select_default(prompt_bufnr)
            end
          end,
        },
      },
    },
    pickers = {
      live_grep = {
        additional_args = function(opts)
          return { "--hidden" }
        end,
      },
    },
    extensions = {
      media_files = {
        filetypes = media_extensions,
        find_cmd = "rg",
      },
    },
  })

  require("telescope").load_extension("media_files")
end

return M
