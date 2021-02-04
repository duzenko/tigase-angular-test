import { jid as parseJid, xml } from '@xmpp/client';
import { JID } from '@xmpp/jid';
import { Element } from 'ltx';
import { BehaviorSubject, Subject } from 'rxjs';
import { ContactMetadata } from '../../../../core/contact';
import { Direction, Message } from '../../../../core/message';
import { DateMessagesGroup, MessageStore } from '../../../../core/message-store';
import { IqResponseStanza, Stanza } from '../../../../core/stanza';
import { LogService } from '../../../log.service';
import { AbstractStanzaBuilder } from '../abstract-stanza-builder';
import { XmppChatAdapter } from '../xmpp-chat-adapter.service';
import { AbstractXmppPlugin } from './abstract-xmpp-plugin';
import { MessageReceivedEvent } from './message.plugin';
import { ServiceDiscoveryPlugin } from './service-discovery.plugin';

export interface RoomCreationOptions {
    name?: string;
    roomId: string;
    public: boolean;
    membersOnly: boolean;
    nonAnonymous: boolean;
    persistentRoom: boolean;
    nick?: string;
    /** ejabberd MucSub */
    allowSubscription?: boolean;
}

export interface RoomMessage extends Message {
    from: JID;
}

export interface Occupant {
    roomJid: JID;
    realJid?: JID;
    metadata: ContactMetadata;
}

export class Room {

    roomJid: JID;
    occupantJid: JID;
    private messageStore: MessageStore<RoomMessage>;
    name: string;

    constructor(occupantJid: JID, logService: LogService) {
        this.roomJid = occupantJid.bare();
        this.occupantJid = occupantJid;
        this.messageStore = new MessageStore<RoomMessage>(logService);
    }

    get messages(): RoomMessage[] {
        return this.messageStore.messages;
    }

    get messages$(): Subject<RoomMessage> {
        return this.messageStore.messages$;
    }

    get mostRecentMessage() {
        return this.messageStore.messages[this.messageStore.messages.length - 1];
    }

    addMessage(message: RoomMessage) {
        this.messageStore.addMessage(message);
    }

    get dateMessagesGroups(): DateMessagesGroup<RoomMessage>[] {
        return this.messageStore.dateMessageGroups;
    }

}

class RoomMessageStanzaBuilder extends AbstractStanzaBuilder {

    constructor(private roomJid: string, private from: string, private body: string, private thread?: string) {
        super();
    }

    toStanza(): Stanza {
        const messageStanza = xml('message', {from: this.from, to: this.roomJid, type: 'groupchat'},
            xml('body', {}, this.body)
        );
        if (this.thread) {
            messageStanza.children.push(
                xml('thread', {}, this.thread)
            );
        }
        return messageStanza;
    }

}

export enum Affiliation {
    none,
    member,
    admin,
    owner,
    outcast
}

class QueryMemberListStanzaBuilder extends AbstractStanzaBuilder {

    constructor(private roomJid: string, private affiliation: string) {
        super();
    }

    static build(roomJid: string, affiliation: string): Stanza {
        return new QueryMemberListStanzaBuilder(roomJid, affiliation).toStanza();
    }

    toStanza(): Stanza {
        return xml('iq', {type: 'get', to: this.roomJid},
            xml('query', {xmlns: 'http://jabber.org/protocol/muc#admin'},
                xml('item', {affiliation: this.affiliation})
            )
        );
    }

}

export interface MemberlistItem {
    jid: string;
    affiliation: Affiliation;
    nick?: string;
}

export interface RoomSummary {
    jid: string;
    name: string;
}

class ModifyMemberListStanzaBuilder extends AbstractStanzaBuilder {

    constructor(private roomJid: string, private modifications: MemberlistItem[]) {
        super();
    }

    static build(roomJid: string, modifications: MemberlistItem[]): Stanza {
        return new ModifyMemberListStanzaBuilder(roomJid, modifications).toStanza();
    }

    toStanza(): Stanza {
        return xml('iq', {to: this.roomJid, type: 'set'},
            xml('query', {xmlns: 'http://jabber.org/protocol/muc#admin'},
                ...this.modifications.map(modification => this.buildItem(modification))
            )
        );
    }

    private buildItem(modification: MemberlistItem) {
        const item = xml('item', {jid: modification.jid, affiliation: Affiliation[modification.affiliation]});
        if (modification.nick) {
            item.attrs.nick = modification.nick;
        }
        return item;
    }
}

/**
 * @see https://xmpp.org/extensions/xep-0045.html
 */
export class MultiUserChatPlugin extends AbstractXmppPlugin {

    rooms$ = new BehaviorSubject<Room[]>([]);
    message$ = new Subject<Room>();
    private roomJoinPromises: { [roomAndJid: string]: (stanza: Stanza) => void } = {};

    constructor(private xmppChatAdapter: XmppChatAdapter,
                private logService: LogService,
                private serviceDiscoveryPlugin: ServiceDiscoveryPlugin) {
        super();
    }

    onOffline() {
        this.roomJoinPromises = {};
        this.rooms$.next([]);
    }

    handleStanza(stanza: Stanza): boolean {
        if (this.isRoomPresenceStanza(stanza)) {
            return this.handleRoomPresenceStanza(stanza);
        } else if (this.isRoomMessageStanza(stanza)) {
            return this.handleRoomMessageStanza(stanza);
        }
        return false;
    }

    private isRoomPresenceStanza(stanza: Stanza) {
        return stanza.name === 'presence' && (
            stanza.getChild('x', 'http://jabber.org/protocol/muc')
            || stanza.getChild('x', 'http://jabber.org/protocol/muc#user')
        );
    }

    private handleRoomPresenceStanza(stanza: Stanza): boolean {
        const roomJoinPromises = this.roomJoinPromises[stanza.attrs.from];
        if (roomJoinPromises) {
            delete this.roomJoinPromises[stanza.attrs.from];
            roomJoinPromises(stanza);
            return true;
        }
        return false;
    }

    /**
     * Resolves if room could be configured as requested, rejects if room did exist or server did not accept configuration.
     */
    async createRoom(request: RoomCreationOptions): Promise<Room> {
        const roomId = request.roomId;
        const service = await this.serviceDiscoveryPlugin.findService('conference', 'text');
        const occupantJid = parseJid(roomId, service.jid, request.nick);
        const {presenceResponse, room} = await this.joinRoomInternal(occupantJid, request.name);

        const itemElement = presenceResponse.getChild('x').getChild('item');
        if (itemElement.attrs.affiliation !== 'owner') {
            throw new Error('error creating room, user is not owner: ' + presenceResponse.toString());
        }

        const configurationForm = await this.xmppChatAdapter.chatConnectionService.sendIq(
            xml('iq', {type: 'get', to: room.roomJid.toString()},
                xml('query', {xmlns: 'http://jabber.org/protocol/muc#owner'})
            )
        );

        const configurationListElement = configurationForm.getChild('query').getChild('x');
        if (!configurationListElement) {
            throw new Error('room not configurable');
        }

        const configurationKeyValuePair = {
            ...this.extractDefaultConfiguration(configurationListElement.getChildren('field')),
            ...this.extractRoomCreationRequestConfiguration(request)
        };

        try {
            await this.xmppChatAdapter.chatConnectionService.sendIq(
                xml('iq', {type: 'set', to: room.roomJid.toString()},
                    xml('query', {xmlns: 'http://jabber.org/protocol/muc#owner'},
                        xml('x', {xmlns: 'jabber:x:data', type: 'submit'},
                            xml('field', {var: 'FORM_TYPE'},
                                xml('value', {}, 'http://jabber.org/protocol/muc#roomconfig')
                            ),
                            ...this.convertConfiguration(configurationKeyValuePair)
                        )
                    )
                )
            );
            return room;
        } catch (e) {
            throw new Error('room configuration rejected: ' + e.toString());
        }
    }

    async destroyRoom(roomJid: JID) {
        const roomDestroyedResponse = await this.xmppChatAdapter.chatConnectionService.sendIq(
            xml('iq', {type: 'set', to: roomJid.toString()},
                xml('query', {xmlns: 'http://jabber.org/protocol/muc#owner'},
                    xml('destroy'))));

        const child = roomDestroyedResponse.getChild('error');
        if (child) {
            throw new Error('error destroying room:' + child.attrs.type);
        }

        // TODO: refactor so that we instead listen to the presence destroy stanza
        const allRoomsWithoutDestroyedRoom = this.rooms$.getValue().filter(
            room => !room.roomJid.equals(roomJid)
        );

        this.rooms$.next(allRoomsWithoutDestroyedRoom);

        return roomDestroyedResponse;
    }

    private async joinRoomInternal(roomJid: JID, name?: string) {
        const userJid = this.xmppChatAdapter.chatConnectionService.userJid;
        const occupantJid = parseJid(roomJid.local, roomJid.domain, roomJid.resource || userJid.local);
        const roomJoinedPromise = new Promise<Stanza>(resolve => this.roomJoinPromises[occupantJid.toString()] = resolve);
        await this.xmppChatAdapter.chatConnectionService.send(
            xml('presence', {from: userJid.toString(), to: occupantJid.toString()},
                xml('x', {xmlns: 'http://jabber.org/protocol/muc'})
            )
        );

        const presenceResponse = await roomJoinedPromise;
        if (presenceResponse.getChild('error')) {
            throw new Error('error joining room: ' + presenceResponse.toString());
        }

        let room;
        try {
            room = this.getRoomByJid(roomJid);
        } catch {
            room = new Room(occupantJid, this.logService);
            room.name = name;
            this.rooms$.next([room].concat(this.rooms$.getValue()));
        }

        return {presenceResponse, room};
    }

    async joinRoom(occupantJid: JID): Promise<Room> {
        return (await this.joinRoomInternal(occupantJid)).room;
    }

    async queryAllRooms(): Promise<RoomSummary[]> {
        const conferenceServer = await this.serviceDiscoveryPlugin.findService('conference', 'text');

        const result = [];

        let roomResponse = await this.xmppChatAdapter.chatConnectionService.sendIq(
            xml('iq', {type: 'get', to: conferenceServer.jid.toString()},
                xml('query', {xmlns: ServiceDiscoveryPlugin.DISCO_ITEMS})
            )
        );
        result.push(...this.convertRoomQueryResponse(roomResponse));


        const fin = roomResponse.getChild('fin');
        while (fin && fin.attrs.complete !== 'true') {
            const lastReceivedRoom = fin.getChild('set').getChildText('last');
            roomResponse = await this.xmppChatAdapter.chatConnectionService.sendIq(
                xml('iq', {type: 'get', to: conferenceServer.jid.toString()},
                    xml('query', {xmlns: 'urn:xmpp:mam:2'},
                        xml('set', {xmlns: ServiceDiscoveryPlugin.DISCO_ITEMS},
                            xml('max', {}, 250),
                            xml('after', {}, lastReceivedRoom)
                        )
                    )
                )
            );
            result.push(...await this.convertRoomQueryResponse(roomResponse));
        }
        return result;
    }

    private convertRoomQueryResponse(iq: IqResponseStanza): RoomSummary[] {
        const queryElement = iq.getChild('query', ServiceDiscoveryPlugin.DISCO_ITEMS);
        const roomElements = queryElement && queryElement.getChildren('item');
        return roomElements.map(room => room.attrs as any);
    }

    async queryMemberList(room: Room): Promise<MemberlistItem[]> {
        const responsePromises = [
            this.xmppChatAdapter.chatConnectionService.sendIq(QueryMemberListStanzaBuilder.build(room.roomJid.toString(), 'admin')),
            this.xmppChatAdapter.chatConnectionService.sendIq(QueryMemberListStanzaBuilder.build(room.roomJid.toString(), 'member')),
            this.xmppChatAdapter.chatConnectionService.sendIq(QueryMemberListStanzaBuilder.build(room.roomJid.toString(), 'owner')),
            this.xmppChatAdapter.chatConnectionService.sendIq(QueryMemberListStanzaBuilder.build(room.roomJid.toString(), 'outcast')),
        ];

        const memberQueryResponses = await Promise.all(responsePromises);
        let members: MemberlistItem[] = [];
        for (const memberQueryResponse of memberQueryResponses) {
            const membersFromQueryResponse = memberQueryResponse.getChild('query').getChildren('item')
                .map((memberItem: Element) => ({
                    jid: memberItem.attrs.jid,
                    nick: memberItem.attrs.nick,
                    affiliation: this.reverseMapAffiliation(memberItem.attrs.affiliation),
                }));
            members = members.concat(membersFromQueryResponse);
        }

        return members;
    }

    private reverseMapAffiliation(value: string): Affiliation {
        if (!value || value === 'none') {
            return Affiliation.none;
        } else if (value === 'member') {
            return Affiliation.member;
        } else if (value === 'admin') {
            return Affiliation.admin;
        } else if (value === 'owner') {
            return Affiliation.owner;
        } else if (value === 'outcast') {
            return Affiliation.outcast;
        } else {
            const message = 'unexpected affilation: ' + value;
            this.logService.error(message);
            throw new Error(message);
        }
    }

    async modifyMemberList(roomJid: string, jid: string, affiliation: Affiliation, nick?: string): Promise<IqResponseStanza> {
        return await this.xmppChatAdapter.chatConnectionService.sendIq(
            ModifyMemberListStanzaBuilder.build(roomJid, [{jid, affiliation, nick}])
        );
    }

    async sendMessage(room: Room, body: string, thread?: string) {
        const from = this.xmppChatAdapter.chatConnectionService.userJid;
        const roomMessageStanza = new RoomMessageStanzaBuilder(room.roomJid.toString(), from.toString(), body, thread)
            .toStanza();

        for (const plugin of this.xmppChatAdapter.plugins) {
            plugin.beforeSendMessage(roomMessageStanza);
        }

        return this.xmppChatAdapter.chatConnectionService.send(roomMessageStanza);
    }

    private convertConfiguration(configurationKeyValuePair: { [key: string]: string[] }) {
        const configurationFields = [];
        for (const configurationKey in configurationKeyValuePair) {
            if (configurationKeyValuePair.hasOwnProperty(configurationKey)) {
                const configurationValues = configurationKeyValuePair[configurationKey].map(value => xml('value', {}, value));
                configurationFields.push(
                    xml('field', {var: configurationKey}, ...configurationValues)
                );
            }
        }
        return configurationFields;
    }

    private extractDefaultConfiguration(fields: Element[]) {
        const configuration: { [key: string]: string[] } = {};
        for (const field of fields) {
            configuration[field.attrs.var] = field.getChildren('value').map(value => value.getText());
        }
        return configuration;
    }

    private extractRoomCreationRequestConfiguration(request: RoomCreationOptions): { [key: string]: string[] } {
        const configuration: { [key: string]: string[] } = {};
        configuration['muc#roomconfig_whois'] = [request.nonAnonymous ? 'anyone' : 'moderators'];
        configuration['muc#roomconfig_publicroom'] = [request.public ? '1' : '0'];
        configuration['muc#roomconfig_membersonly'] = [request.membersOnly ? '1' : '0'];
        configuration['muc#roomconfig_persistentroom'] = [request.persistentRoom ? '1' : '0'];

        if (request.allowSubscription !== undefined) {
            // tslint:disable-next-line:no-string-literal
            configuration['allow_subscription'] = [request.allowSubscription === true ? '1' : '0'];
        }

        return configuration;
    }

    private isRoomMessageStanza(stanza: Stanza) {
        return stanza.name === 'message' && stanza.attrs.type === 'groupchat' && !!stanza.getChildText('body');
    }

    private handleRoomMessageStanza(stanza: Stanza) {
        let datetime;
        const delay = stanza.getChild('delay');
        if (delay && delay.attrs.stamp) {
            datetime = new Date(delay.attrs.stamp);
        } else {
            datetime = new Date(); // TODO: replace with entity time plugin
        }

        const from = parseJid(stanza.attrs.from);
        const room = this.getRoomByJid(from.bare());

        const message = {
            body: stanza.getChildText('body'),
            datetime,
            id: stanza.attrs.id,
            from,
            direction: from.equals(room.occupantJid) ? Direction.out : Direction.in,
            delayed: !!stanza.getChild('delay')
        };

        const messageReceivedEvent = new MessageReceivedEvent();
        for (const plugin of this.xmppChatAdapter.plugins) {
            plugin.afterReceiveMessage(message, stanza, messageReceivedEvent);
        }
        if (!messageReceivedEvent.discard) {
            room.addMessage(message);
        }

        if (!message.delayed) {
            this.message$.next(room);
        }

        return true;
    }

    private getRoomByJid(jid: JID) {
        for (const room of this.rooms$.getValue()) {
            if (room.roomJid.equals(jid)) {
                return room;
            }
        }

        throw new Error('no room with given jid found: ' + jid.toString());
    }

}
