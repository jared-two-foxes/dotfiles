"""Offline contract/fixture tests, not an executor or a production patch parser."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[1]
ARCH = ROOT / 'opencode/docs/architecture'
EXAMPLE = ARCH / 'examples/greeting'
KEYS = ('plan_id', 'plan_revision', 'design_id', 'design_revision',
        'requirements_id', 'requirements_revision')
STEPS = ('validate_manifest', 'validate_approval', 'check_repository',
         'validate_patch', 'create_worktree', 'check_apply', 'apply_patch',
         'verify_tree', 'create_commit', 'publish_revision')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validator(name):
    schema = read(ARCH / 'schemas' / (name + '.v1.schema.json'))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def git_environment():
    # Exclude inherited Git variables and host config, filters and hooks.
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_AUTHOR_NAME='Workflow Example',
               GIT_AUTHOR_EMAIL='workflow@example.invalid',
               GIT_COMMITTER_NAME='Workflow Example',
               GIT_COMMITTER_EMAIL='workflow@example.invalid',
               GIT_AUTHOR_DATE='2026-01-01T00:00:00Z',
               GIT_COMMITTER_DATE='2026-01-01T00:00:00Z', LC_ALL='C')
    return env


class Contracts(unittest.TestCase):
    def test_schemas_and_all_examples(self):
        for schema_name, files in {
            'execution-manifest': ('execution-manifest.json', 'r2/execution-manifest.json'),
            'execution-result': ('execution-success.json', 'execution-failed.json',
                                 'execution-invalid.json'),
            'review-result': ('review-result.json',),
        }.items():
            for file in files:
                with self.subTest(file=file):
                    validator(schema_name).validate(read(EXAMPLE / file))

    def rejects(self, name, doc):
        with self.assertRaises(ValidationError):
            validator(name).validate(doc)

    def test_manifest_rejects_missing_fields_and_unknown_version(self):
        original = read(EXAMPLE / 'execution-manifest.json')
        for key in original:
            with self.subTest(missing=key):
                doc = copy.deepcopy(original)
                del doc[key]
                self.rejects('execution-manifest', doc)
        for key, value in [('schema_version', 'execution-manifest/v2'),
                           ('run_command', 'arbitrary script')]:
            doc = copy.deepcopy(original)
            doc[key] = value
            self.rejects('execution-manifest', doc)

    def test_manifest_rejects_unsafe_shapes(self):
        original = read(EXAMPLE / 'execution-manifest.json')
        for unsafe in ('../secret', '/etc/passwd', 'C:\\secret', 'a//b', './a'):
            with self.subTest(path=unsafe):
                doc = copy.deepcopy(original)
                doc['policy']['allowed_paths'] = [unsafe]
                self.rejects('execution-manifest', doc)
        for key in ('allow_offset', 'allow_three_way', 'allow_partial',
                    'allow_symlinks', 'allow_binary'):
            doc = copy.deepcopy(original)
            doc['policy'][key] = True
            self.rejects('execution-manifest', doc)
        for key, value in [('sha256', 'not-a-checksum'), ('format', 'full-file')]:
            doc = copy.deepcopy(original)
            doc['patch'][key] = value
            self.rejects('execution-manifest', doc)
        doc = copy.deepcopy(original)
        doc['files'][1]['base_blob'] = 'a' * 40  # create cannot have old blob
        self.rejects('execution-manifest', doc)
        doc = copy.deepcopy(original)
        doc['files'][0]['base_blob'] = None
        self.rejects('execution-manifest', doc)

    def test_results_reject_contradictions(self):
        success = read(EXAMPLE / 'execution-success.json')
        for key in success:
            doc = copy.deepcopy(success)
            del doc[key]
            self.rejects('execution-result', doc)
        for key, value in [('resulting_commit', None), ('plan_revision', None),
                           ('schema_version', 'execution-result/v2')]:
            doc = copy.deepcopy(success)
            doc[key] = value
            self.rejects('execution-result', doc)
        doc = copy.deepcopy(success)
        doc['operations'].pop()
        self.rejects('execution-result', doc)
        doc = copy.deepcopy(success)
        doc['publication']['published_for_review'] = False
        self.rejects('execution-result', doc)
        doc = read(EXAMPLE / 'execution-failed.json')
        doc['publication'] = success['publication']
        self.rejects('execution-result', doc)
        doc = read(EXAMPLE / 'execution-failed.json')
        doc['error']['classification'] = 'plan_invalid'
        self.rejects('execution-result', doc)
        doc = read(EXAMPLE / 'execution-failed.json')
        doc['error']['code'] = 'MADE_UP'
        self.rejects('execution-result', doc)

    def test_review_cannot_approve_failed_or_missing_evidence(self):
        doc = read(EXAMPLE / 'review-result.json')
        for key in doc:
            broken = copy.deepcopy(doc)
            del broken[key]
            self.rejects('review-result', broken)
        doc['disposition'] = 'accepted'
        self.rejects('review-result', doc)
        doc['semantic']['status'] = 'APPROVED'
        doc['semantic']['findings'] = []
        self.rejects('review-result', doc)  # criterion still failed
        doc['criteria'][1]['status'] = 'passed'
        validator('review-result').validate(doc)
        for status in ('failed', 'not_run', 'environment_error'):
            broken = copy.deepcopy(doc)
            broken['mechanical_checks'][0].update(status=status, exit_code=None)
            self.rejects('review-result', broken)
        for status in ('INDETERMINATE', 'ERROR'):
            broken = copy.deepcopy(doc)
            broken['semantic']['status'] = status
            self.rejects('review-result', broken)
        doc['source_unchanged'] = False
        self.rejects('review-result', doc)

    def test_cross_artifact_identity_and_feedback(self):
        manifest = read(EXAMPLE / 'execution-manifest.json')
        success = read(EXAMPLE / 'execution-success.json')
        review = read(EXAMPLE / 'review-result.json')
        failed = read(EXAMPLE / 'execution-failed.json')
        for result in (success, review, failed):
            self.assertEqual([manifest[k] for k in KEYS], [result[k] for k in KEYS])
            self.assertEqual(manifest['repository']['base_commit'], result['base_commit'])
        self.assertEqual(success['resulting_commit'], review['resulting_commit'])
        self.assertEqual(success['attempt_id'], review['execution_attempt_id'])
        self.assertEqual(list(STEPS), [op['name'] for op in success['operations']])
        self.assertEqual(failed['error']['operation'], failed['operations'][-1]['name'])
        raw = read(EXAMPLE / review['semantic']['raw_result'])
        for key in ('status', 'reason', 'review_id', 'findings'):
            self.assertEqual(raw[key], review['semantic'][key])
        self.assertEqual(raw['schema'], review['semantic']['source_schema'])
        r2 = read(EXAMPLE / 'r2/execution-manifest.json')
        for key in ('plan_id', 'design_id', 'requirements_id', 'requirements_revision'):
            self.assertEqual(r2[key], manifest[key])
        self.assertEqual(r2['plan_revision'], manifest['plan_revision'] + 1)
        self.assertEqual(r2['design_revision'], manifest['design_revision'] + 1)
        self.assertEqual(r2['repository'], manifest['repository'])
        self.assertNotEqual(r2['patch']['sha256'], manifest['patch']['sha256'])
        self.assertNotEqual(r2['design']['sha256'], manifest['design']['sha256'])

    def test_patch_integrity_exact_base_and_result(self):
        for revision in (1, 2):
            with self.subTest(revision=revision), tempfile.TemporaryDirectory() as temp:
                repo = Path(temp)
                manifest = read(EXAMPLE / ('execution-manifest.json' if revision == 1
                                           else 'r2/execution-manifest.json'))
                patch = EXAMPLE / manifest['patch']['artifact']
                self.assertEqual(digest(patch), manifest['patch']['sha256'])
                self.assertEqual(digest(EXAMPLE / manifest['design']['artifact']),
                                 manifest['design']['sha256'])
                def git(*args, check=True):
                    return subprocess.run(
                        ['git', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + os.devnull,
                         *args], cwd=repo, env=git_environment(), capture_output=True, check=check)
                git('init', '-q', '--object-format=sha1')
                (repo / 'greeting.py').write_bytes((EXAMPLE / 'base/greeting.py').read_bytes())
                (repo / 'greeting.py').chmod(0o644)
                git('add', 'greeting.py')
                git('commit', '-qm', 'Example base')
                self.assertEqual(git('rev-parse', 'HEAD').stdout.decode().strip(),
                                 manifest['repository']['base_commit'])
                self.assertEqual(git('rev-parse', 'HEAD:greeting.py').stdout.decode().strip(),
                                 manifest['files'][0]['base_blob'])
                git('apply', '--check', '--index', '--whitespace=error-all', str(patch))
                git('apply', '--index', '--whitespace=error-all', str(patch))
                actual_paths = git('diff', '--cached', '--name-only').stdout.decode().splitlines()
                self.assertEqual(sorted(actual_paths), sorted(manifest['policy']['allowed_paths']))
                self.assertEqual(sorted(actual_paths), sorted(f['path'] for f in manifest['files']))
                regenerated = git('diff', '--cached', '--full-index', '--no-ext-diff',
                                  '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--').stdout
                self.assertEqual(regenerated, patch.read_bytes())
                self.assertEqual((repo / 'greeting.py').read_bytes(),
                                 (EXAMPLE / 'expected/greeting.py').read_bytes())
                if revision == 1:
                    self.assertEqual((repo / 'test_greeting.py').read_bytes(),
                                     (EXAMPLE / 'expected/test_greeting.py').read_bytes())
                else:
                    self.assertIn('with self.subTest', (repo / 'test_greeting.py').read_text())
                    self.assertIn('"\\tAda\\t", "\\nAda\\n"', (repo / 'test_greeting.py').read_text())
                # This suite may execute the fictional fixture, unlike the Design stage.
                tests = subprocess.run(['python', '-B', '-m', 'unittest', '-v'], cwd=repo,
                                       capture_output=True, text=True, check=True)
                self.assertIn('Ran 2 tests', tests.stderr)
                git('commit', '-qm', manifest['commit']['message'])
                if revision == 1:
                    self.assertEqual(git('rev-parse', 'HEAD').stdout.decode().strip(),
                                     read(EXAMPLE / 'execution-success.json')['resulting_commit'])
                    snapshot = hashlib.sha256(b''.join(
                        n.encode() + b'\0' + (repo / n).read_bytes()
                        for n in ('greeting.py', 'test_greeting.py'))).hexdigest()
                    self.assertEqual(snapshot, read(EXAMPLE / 'review-result.json')['source_snapshot'])
                # Git rejects corrupt context and a malformed hunk count.
                git('reset', '--hard', manifest['repository']['base_commit'])
                git('clean', '-fd')
                corrupt = repo / 'bad.patch'
                for bad in (patch.read_bytes().replace(b'-    return "Hello, " + name',
                                                       b'-    return "Missing, " + name'),
                            patch.read_bytes().replace(b'@@ -1,2 +1,2 @@', b'@@ -1,99 +1,2 @@')):
                    corrupt.write_bytes(bad)
                    self.assertNotEqual(git('apply', '--check', '--index', str(corrupt),
                                            check=False).returncode, 0)


if __name__ == '__main__':
    unittest.main()
