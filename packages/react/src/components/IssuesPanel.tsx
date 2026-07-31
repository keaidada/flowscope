import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useLineage } from '../store';
import type { IssuesPanelProps, Issue } from '../types';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function IssuesPanel({ className, onIssueClick }: IssuesPanelProps): JSX.Element {
  const { t } = useTranslation();
  const { state, actions } = useLineage();
  const { result } = state;

  const sortedIssues =
    result?.issues
      .slice()
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || [];

  const handleIssueClick = (issue: Issue) => {
    if (issue.span) {
      actions.highlightSpan(issue.span);
    }
    if (issue.statementIndex !== undefined) {
      actions.selectStatement(issue.statementIndex);
    }
    onIssueClick?.(issue);
  };

  if (!result) {
    return (
      <div className={`capybara-issues-panel capybara-panel-empty ${className || ''}`}>
        <p>No data available</p>
      </div>
    );
  }

  const { errors, warnings, infos } = result.summary.issueCount;

  return (
    <div className={`capybara-issues-panel ${className || ''}`}>
      <div className="capybara-panel-header">
        <h3>Issues</h3>
        <div className="capybara-issue-counts">
          {errors > 0 && <span className="capybara-count-error">{errors} errors</span>}
          {warnings > 0 && <span className="capybara-count-warning">{warnings} warnings</span>}
          {infos > 0 && <span className="capybara-count-info">{infos} info</span>}
          {sortedIssues.length === 0 && <span className="capybara-count-success">No issues</span>}
        </div>
      </div>
      <div className="capybara-panel-content">
        {sortedIssues.length === 0 ? (
          <p className="capybara-hint">{t('issuesPanelReact.completedWithout')}</p>
        ) : (
          <ul className="capybara-issue-list">
            {sortedIssues.map((issue, idx) => (
              <li
                key={`${issue.code}-${idx}`}
                className={`capybara-issue capybara-issue-${issue.severity}`}
                onClick={() => handleIssueClick(issue)}
              >
                <div className="capybara-issue-header">
                  <span className={`capybara-severity capybara-severity-${issue.severity}`}>
                    {issue.severity}
                  </span>
                  <code className="capybara-issue-code">{issue.code}</code>
                </div>
                <p className="capybara-issue-message">{issue.message}</p>
                {issue.statementIndex !== undefined && (
                  <span className="capybara-issue-location">
                    Statement {issue.statementIndex + 1}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
