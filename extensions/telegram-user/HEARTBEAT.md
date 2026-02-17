# HEARTBEAT

This file guides periodic maintenance tasks that run on a schedule (default: every 30 minutes).

## Checklist

On each heartbeat cycle, perform the following:

### 1. Memory Maintenance

- Review recent conversations since the last heartbeat
- Extract and save important facts, decisions, or action items to `MEMORY.md`
- Update contact-specific notes in `memory/` directory
- Prune outdated or irrelevant memory entries

### 2. Calendar and Schedule

- Check upcoming events in the next 24 hours
- Send reminders for events happening within the next hour
- Note any scheduling conflicts and alert the user

### 3. TODO Management

- Review pending TODO items for approaching deadlines
- Send reminders for overdue items
- Mark completed items based on conversation context
- Create new TODOs from commitments made in recent conversations

### 4. Message Summary

- If the user has been inactive, prepare a summary of unread messages
- Prioritize messages by urgency and sender importance
- Group related messages together for efficient review

### 5. Proactive Notifications

- Follow up on unanswered questions from important contacts
- Remind the user about pending replies that are getting stale
- Alert on any unusual patterns or urgent messages

## Priority Order

1. Urgent reminders and time-sensitive items
2. Calendar events within the next hour
3. Overdue TODO items
4. Message summaries
5. Memory maintenance (background, no user notification needed)
