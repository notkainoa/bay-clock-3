# Bay Clock 3

Third and possibly final iteration of Bay Clock.

[Visit Here](https://bayclock.org)

## Interested in Managing Bay Clock?

Email me at lucaskchang@gmail.com and visit [this guide](https://lucaschang.notion.site/Bay-Clock-Guide-4b3b8d76ee0a428083cfd9cc37f1ca89).

## Menu Upload Pipeline

Live lunch menu rendering still reads [`public/menu/menu.jpg`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/public/menu/menu.jpg) through [`LunchMenu.vue`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/components/LunchMenu.vue#L17).

- The private uploader lives in [`cloudflare/menu-admin`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/cloudflare/menu-admin/README.md).
- The repo-side publisher lives in [`update-menu-image.yml`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/.github/workflows/update-menu-image.yml).
- Upload processing is handled by [`process_menu_upload.py`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/scripts/process_menu_upload.py).
