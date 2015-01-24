/* vim: ts=4:sw=4:expandtab
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

;(function() {
    'use strict';
    var conversations = new Whisper.ConversationCollection();
    var messages      = new Whisper.MessageCollection();

    if (!localStorage.getItem('first_install_ran')) {
        localStorage.setItem('first_install_ran', 1);
        extension.navigator.tabs.create("options.html");
    }

    if (textsecure.registration.isDone()) {
        init();
    }
    extension.on('registration_done', init);

    function init() {
        if (!textsecure.registration.isDone()) { return; }

        // initialize the socket and start listening for messages
        var socket = textsecure.api.getMessageWebsocket();
        new WebSocketResource(socket, function(request) {
            // TODO: handle different types of requests. for now we only expect
            // PUT /messages <encrypted IncomingPushMessageSignal>
            textsecure.protocol.decryptWebsocketMessage(request.body).then(function(plaintext) {
                var proto = textsecure.protobuf.IncomingPushMessageSignal.decode(plaintext);
                // After this point, decoding errors are not the server's
                // fault, and we should handle them gracefully and tell the
                // user they received an invalid message
                request.respond(200, 'OK');

                if (proto.type === textsecure.protobuf.IncomingPushMessageSignal.Type.RECEIPT) {
                    onDeliveryReceipt(proto);
                } else {
                    onMessageReceived(proto);
                }

            }).catch(function(e) {
                console.log("Error handling incoming message:", e);
                extension.trigger('error', e);
                request.respond(500, 'Bad encrypted websocket message');
            });
        });
        var opened = false;
        var panel = 0;

        chrome.browserAction.onClicked.addListener(function () {
            if (opened === false) {
                opened = true;
                chrome.windows.create({
                    url: 'index.html',
                    type: 'panel',
                    focused: true,
                    width: 260, // 280 for chat
                    height: 440 // 420 for chat
                }, function (window) {
                    var isPanelEnabled = window.alwaysOnTop;
                    panel = window.id;
                });
            } else if (opened === true) {
                chrome.windows.update(panel, { focused: true });
            }
            chrome.windows.onRemoved.addListener(function (windowId) {
                if (windowId === panel) {
                    panel = 0;
                    opened = false;
                }
            });
        });
    };

    function onMessageReceived(pushMessage) {
        var now = new Date().getTime();
        var timestamp = pushMessage.timestamp.toNumber();

        var conversation = conversations.add({
            id   : pushMessage.source,
            type : 'private'
        }, { merge : true } );

        var message = messages.add({
            source         : pushMessage.source,
            sourceDevice   : pushMessage.sourceDevice,
            relay          : pushMessage.relay,
            sent_at        : timestamp,
            received_at    : now,
            conversationId : pushMessage.source,
            type           : 'incoming'
        });

        var newUnreadCount = textsecure.storage.getUnencrypted("unreadCount", 0) + 1;
        textsecure.storage.putUnencrypted("unreadCount", newUnreadCount);
        extension.navigator.setBadgeText(newUnreadCount);

        conversation.save().then(function() {
            message.save().then(function() {
                return new Promise(function(resolve) {
                    resolve(textsecure.protocol.handleIncomingPushMessageProto(pushMessage).then(
                        function(pushMessageContent) {
                            handlePushMessageContent(pushMessageContent, message);
                        }
                    ));
                }).catch(function(e) {
                    if (e.name === 'IncomingIdentityKeyError') {
                        e.args.push(message.id);
                        message.save({ errors : [e] }).then(function() {
                            extension.trigger('message', message); // notify frontend listeners
                        });
                    } else if (e.message === 'Bad MAC') {
                        message.save({ errors : [ _.pick(e, ['name', 'message'])]}).then(function() {
                            extension.trigger('message', message); // notify frontend listeners
                        });
                    } else {
                        console.log(e);
                        throw e;
                    }
                });
            });
        });
    };

    extension.on('message:decrypted', function(options) {
        var message = messages.add({id: options.message_id});
        message.fetch().then(function() {
            var pushMessageContent = handlePushMessageContent(
                new textsecure.protobuf.PushMessageContent(options.data),
                message
            );
        });
    });

    function handlePushMessageContent(pushMessageContent, message) {
        // This function can be called from the background script on an
        // incoming message or from the frontend after the user accepts an
        // identity key change.
        var source = message.get('source');
        return textsecure.processDecrypted(pushMessageContent, source).then(function(pushMessageContent) {
            var now = new Date().getTime();
            var conversationId = pushMessageContent.group ? pushMessageContent.group.id : source;
            var conversation = new Whisper.Conversation({id: conversationId});
            var attributes = {};
            conversation.fetch().always(function() {
                if (pushMessageContent.group &&
                    pushMessageContent.group.type === textsecure.protobuf.PushMessageContent.GroupContext.Type.UPDATE) {
                    attributes = {
                        type       : 'group',
                        groupId    : pushMessageContent.group.id,
                        name       : pushMessageContent.group.name,
                        avatar     : pushMessageContent.group.avatar,
                        members    : pushMessageContent.group.members,
                    };
                    var group_update = conversation.changedAttributes(_.pick(pushMessageContent.group, 'name', 'avatar'));
                    var difference = _.difference(pushMessageContent.group.members, conversation.get('members'));
                    if (difference.length > 0) {
                        group_update.joined = difference;
                    }
                    if (_.keys(group_update).length > 0) {
                        message.set({group_update: group_update});
                    }
                }
                attributes.active_at = now;
                conversation.set(attributes);

                message.set({
                    body           : pushMessageContent.body,
                    conversationId : conversation.id,
                    attachments    : pushMessageContent.attachments,
                    decrypted_at   : now,
                    errors         : []
                });

                if (message.get('sent_at') > conversation.get('timestamp')) {
                    conversation.set({ timestamp: message.get('sent_at'), lastMessage: message.get('body') });
                }

                conversation.save().then(function() {
                    message.save().then(function() {
                        extension.trigger('message', message); // notify frontend listeners
                    });
                });
            });
        });
    }

    function onDeliveryReceipt(pushMessage) {
        var timestamp = pushMessage.timestamp.toNumber();
        var messages  = new Whisper.MessageCollection();
        var groups    = new Whisper.ConversationCollection();
        console.log('delivery receipt', pushMessage.source, timestamp);
        messages.fetchSentAt(timestamp).then(function() {
            groups.fetchGroups(pushMessage.source).then(function() {
                for (var i in messages.where({type: 'outgoing'})) {
                    var message = messages.at(i);
                    var deliveries     = message.get('delivered') || 0;
                    var conversationId = message.get('conversationId');
                    if (conversationId === pushMessage.source || groups.get(conversationId)) {
                        message.save({delivered: deliveries + 1}).then(function() {
                            extension.trigger('message', message); // notify frontend listeners
                        });
                        return;
                        // TODO: consider keeping a list of numbers we've
                        // successfully delivered to?
                    }
                }
            });
        }).fail(function() {
            console.log('got delivery receipt for unknown message', pushMessage.source, timestamp);
        });
    };

    var windowMap = Whisper.windowMap = new Whisper.Bimap('windowId', 'modelId');

    // make sure panels are cleaned up on close
    chrome.windows.onRemoved.addListener(function (windowId) {
        if (windowMap.windowId[windowId]) {
            closeConversation(windowId);
        }
    });

})();
