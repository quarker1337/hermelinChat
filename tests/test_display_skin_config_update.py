import textwrap
import unittest

from hermelin.server import _update_display_skin_config_text


class DisplaySkinConfigUpdateTests(unittest.TestCase):
    def test_replaces_existing_nested_skin_without_rewriting_other_content(self):
        original = textwrap.dedent(
            """\
            # top comment
            model: foo/bar
            display:
              compact: true
              skin: old-skin
              # keep me
              tool_progress: false
            memory:
              memory_enabled: true
            """
        )

        updated, changed = _update_display_skin_config_text(original, "matrix")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                # top comment
                model: foo/bar
                display:
                  compact: true
                  skin: matrix
                  # keep me
                  tool_progress: false
                memory:
                  memory_enabled: true
                """
            ),
        )

    def test_inserts_skin_into_existing_display_block(self):
        original = textwrap.dedent(
            """\
            model: foo/bar
            display:
              # display prefs
              compact: true
              tool_progress: false
            """
        )

        updated, changed = _update_display_skin_config_text(original, "nous")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                model: foo/bar
                display:
                  # display prefs
                  skin: nous
                  compact: true
                  tool_progress: false
                """
            ),
        )

    def test_appends_display_block_when_missing(self):
        original = textwrap.dedent(
            """\
            model: foo/bar
            memory:
              memory_enabled: true
            """
        )

        updated, changed = _update_display_skin_config_text(original, "hermelin")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                model: foo/bar
                memory:
                  memory_enabled: true

                display:
                  skin: hermelin
                """
            ),
        )

    def test_updates_flat_display_skin_key_in_place(self):
        original = textwrap.dedent(
            """\
            model: foo/bar
            display.skin: old-skin
            memory:
              memory_enabled: true
            """
        )

        updated, changed = _update_display_skin_config_text(original, "samaritan")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                model: foo/bar
                display.skin: samaritan
                memory:
                  memory_enabled: true
                """
            ),
        )


if __name__ == "__main__":
    unittest.main()
