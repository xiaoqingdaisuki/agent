from src.repositories import InMemoryRepositories


def test_turn_messages_continue_after_max_explicit_sequence():
    repositories = InMemoryRepositories()
    conversation = repositories.create_conversation(
        "sequence-user", "Sequence", conversation_id="sequence-conversation"
    )
    repositories.create_message_batch(
        conversation["id"],
        "sequence-user",
        [
            {
                "id": "message-zero",
                "sequence_no": 0,
                "role": "user",
                "content": "zero",
                "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "id": "message-two",
                "sequence_no": 2,
                "role": "assistant",
                "content": "two",
                "created_at": "2026-01-01T00:00:01Z",
            },
        ],
    )

    _turn, user_message, _created = repositories.begin_turn(
        conversation["id"],
        "sequence-user",
        "client-message",
        "next",
        "turn-next",
        "message-next",
    )

    assert user_message["sequence_no"] == 3
